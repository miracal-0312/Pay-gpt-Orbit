#!/usr/bin/env python3
"""Read-only Orbitcard Open API connectivity and response-shape check.

Only allowlisted POST queries are sent. Never prints API credentials, sessions,
full card numbers, CVV, or raw upstream responses.
"""

from __future__ import annotations

import argparse
import decimal
import hashlib
import hmac
import http.client
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


READ_OPERATIONS = frozenset({
    "getAccountBalance", "getProductCode", "getCardList", "cardDetail",
    "cardTransaction", "getCardFlow", "getSubscriptionPlans",
    "getSubscriptionCatalog", "getSubscriptionPaymentRegions",
    "getSubscriptionList", "getSubscription",
})
BALANCE_FIELDS = (
    "available_balance", "frozen_balance", "total_balance",
    "pending_deposit_amount", "estimated_card_balance", "updated_at",
)
PAYMENT_PLAN_TYPES = frozenset({"gpt-go", "gpt-plus", "gpt-pro-5x", "gpt-pro-20x", "gpt-pro-25x"})
MAX_RESPONSE_BYTES = 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request: Any, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None


def positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (ValueError, TypeError):
        return None
    return number if number > 0 and str(number) == str(value) else None


def validate_base_url(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("base_url 必须是 HTTPS 根域名")
    parsed = urllib.parse.urlsplit(value.strip())
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("base_url 必须是 HTTPS 根域名，例如 https://orbitcard.cc")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("base_url 端口无效") from exc
    hostname = parsed.hostname.lower()
    if ":" in hostname:
        hostname = f"[{hostname}]"
    return f"https://{hostname}{':' + str(port) if port and port != 443 else ''}"


def load_config(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"无法读取 JSON 配置文件：{path.name}") from exc
    if not isinstance(raw, dict):
        raise ValueError("配置文件顶层必须是 JSON 对象")
    base_url = validate_base_url(raw.get("base_url", "https://orbitcard.cc"))
    if any(key in raw for key in ("api_key", "api_secret", "api_secret_env")):
        raise ValueError("API Key 和 API Secret 只能通过环境变量配置，不能写入 JSON 文件")
    api_key = str(os.environ.get("ORBITCARD_API_KEY") or "").strip()
    api_secret = str(os.environ.get("ORBITCARD_API_SECRET") or "").strip()
    if not api_key or api_key.upper().startswith("REPLACE"):
        raise ValueError("请设置环境变量 ORBITCARD_API_KEY")
    if not api_secret or api_secret.upper().startswith("REPLACE"):
        raise ValueError("请设置环境变量 ORBITCARD_API_SECRET")
    max_cards = raw.get("max_cards", 20)
    if type(max_cards) is not int or not 1 <= max_cards <= 1000:
        raise ValueError("max_cards 必须是 1–1000 的整数")
    card_id = raw.get("card_id")
    if card_id is not None and positive_int(card_id) is None:
        raise ValueError("card_id 必须是正整数或 null")
    task_no = str(raw.get("task_no") or "").strip()
    client_order_no = str(raw.get("client_order_no") or "").strip()
    if task_no and client_order_no:
        raise ValueError("task_no 与 client_order_no 只能填写一个")
    if len(task_no) > 128 or len(client_order_no) > 128:
        raise ValueError("订单编号过长")
    return {
        "base_url": base_url, "api_key": api_key, "api_secret": api_secret,
        "max_cards": max_cards, "card_id": positive_int(card_id),
        "task_no": task_no, "client_order_no": client_order_no,
    }


class OrbitcardClient:
    def __init__(self, config: dict[str, Any], timeout: float = 30.0) -> None:
        self.base_url = config["base_url"]
        self.api_key = config["api_key"]
        self.api_secret = config["api_secret"]
        self.timeout = timeout
        self.opener = urllib.request.build_opener(NoRedirect())

    def signed_request(self, operation: str, body: dict[str, Any]) -> urllib.request.Request:
        if operation not in READ_OPERATIONS:
            raise ValueError("只读检查程序禁止调用写接口")
        path = f"/api/open/v1/{operation}"
        raw_body = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        timestamp = str(int(time.time()))
        nonce = secrets.token_urlsafe(24)
        host = urllib.parse.urlsplit(self.base_url).netloc
        canonical = "\n".join((
            "ORBITCARD-HMAC-SHA256-V1", self.api_key, timestamp, nonce,
            "POST", host, path, "", hashlib.sha256(raw_body).hexdigest(), "",
        ))
        signature = hmac.new(self.api_secret.encode("utf-8"), canonical.encode("utf-8"),
                             hashlib.sha256).hexdigest()
        return urllib.request.Request(
            self.base_url + path, data=raw_body, method="POST",
            headers={
                "Content-Type": "application/json", "X-API-Key": self.api_key,
                "X-Timestamp": timestamp, "X-Nonce": nonce, "X-Signature": signature,
            },
        )

    def request(self, operation: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        request = self.signed_request(operation, body if body is not None else {})
        try:
            response = self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            response = exc
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
            return {"ok": False, "error": "网络或 TLS 连接失败"}
        try:
            with response:
                status = response.status
                retry_after = response.headers.get("Retry-After")
                payload_bytes = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload_bytes) > MAX_RESPONSE_BYTES:
                return {"ok": False, "http_status": status, "error": "响应超过 1 MiB"}
            envelope = json.loads(payload_bytes.decode("utf-8"))
            if not isinstance(envelope, dict):
                raise ValueError("响应不是 JSON 对象")
        except (ValueError, UnicodeError, OSError, http.client.HTTPException):
            return {"ok": False, "http_status": status, "error": "响应 JSON 无效"}
        code = envelope.get("code")
        ok = 200 <= status < 300 and type(code) is int and code == 0
        result: dict[str, Any] = {"ok": ok, "http_status": status, "code": code}
        if ok:
            result["data"] = envelope.get("data")
        else:
            result["error"] = (
                "认证、出口 IP 或签名失败" if status == 401 else
                "API Key 缺少该接口的读取权限" if status == 403 else
                "平台限流，请按 Retry-After 稍后重试" if status == 429 else
                "平台返回错误"
            )
            if status == 429 and retry_after:
                result["retry_after"] = str(retry_after)[:64]
        return result


def rows(data: Any) -> list[dict[str, Any]] | None:
    value = data if isinstance(data, list) else next((data[key] for key in ("list", "items", "cards")
        if isinstance(data, dict) and isinstance(data.get(key), list)), None)
    return value if isinstance(value, list) and all(isinstance(row, dict) for row in value) else None


def card_data(row: dict[str, Any]) -> dict[str, Any]:
    if row.get("success") is False:
        return {}
    if "data" in row:
        if not isinstance(row["data"], dict):
            return {}
        source = card_data(row["data"])
        outer_id = row.get("card_id", row.get("cardId"))
        inner_id = source.get("card_id", source.get("cardId", source.get("id")))
        if outer_id is not None and (positive_int(outer_id) is None or
                                    inner_id is not None and positive_int(outer_id) != positive_int(inner_id)):
            return {}
        return {**source, "card_id": inner_id if inner_id is not None else outer_id}
    return {**row, **row["card"]} if isinstance(row.get("card"), dict) else row


def card_id(row: dict[str, Any]) -> int | None:
    source = card_data(row)
    return positive_int(source.get("card_id", source.get("cardId", source.get("id"))))


def safe_card(row: dict[str, Any]) -> dict[str, Any]:
    source = card_data(row)
    balance = next((source[key] for key in (
        "available_amount", "availableAmount", "available_balance", "availableBalance",
        "card_balance", "cardBalance", "balance",
    ) if key in source and isinstance(source[key], (str, int, float))), None)
    if balance is None and isinstance(source.get("balance_info"), dict):
        balance = source["balance_info"].get("available_balance")
    return {"card_id": card_id(source), "status": str(source.get("status") or source.get("card_status") or "")[:32],
            "product_code": str(source.get("product_code") or "")[:128],
            "available_balance": balance,
            "currency": str(source.get("currency") or source.get("balance_currency") or
                            ("USD" if source.get("card_type") == "save" and source.get("available_amount") is not None
                             and source.get("product_code") else ""))[:8]}


def summarize(operation: str, data: Any) -> Any:
    if operation == "getAccountBalance":
        if not isinstance(data, dict):
            return None
        try:
            available = decimal.Decimal(str(data.get("available_balance")))
            if not available.is_finite() or available < 0:
                return None
        except decimal.InvalidOperation:
            return None
        return {key: data.get(key) for key in BALANCE_FIELDS if key in data}
    if operation == "getProductCode":
        items = rows(data)
        if items is None:
            return None
        products = []
        for item in items:
            product = {key: item.get(key) for key in (
                "product_code", "remaining_open_card_num", "min_initial_amount", "min_retained_balance"
            ) if key in item}
            prices = item.get("gpt_plan_prices")
            product["gpt_plan_prices"] = [{key: price.get(key) for key in (
                                           "id", "name", "price", "currency", "source", "observed_at", "updated_at")
                                           if key in price}
                                          for price in prices if isinstance(price, dict)] if isinstance(prices, list) else None
            products.append(product)
        return {"count": len(items), "products": products,
                "price_field_present": any(isinstance(item.get("gpt_plan_prices"), list) for item in items)}
    if operation in ("getSubscriptionPlans", "getSubscriptionCatalog"):
        if not isinstance(data, dict) or not isinstance(data.get("plans"), list):
            return None
        return {"enabled": data.get("enabled"), "plans": [{key: plan.get(key) for key in
            ("type", "name", "service_fee") if key in plan} for plan in data["plans"] if isinstance(plan, dict)]}
    if operation == "getSubscriptionPaymentRegions":
        if not isinstance(data, dict) or not isinstance(data.get("payment_regions"), list):
            return None
        return {"plan_type": data.get("plan_type"), "regions": [{"code": item.get("code"),
            "default": item.get("default")} for item in data["payment_regions"] if isinstance(item, dict)]}
    if operation in ("getCardList", "cardDetail"):
        items = rows(data)
        if items is None and operation == "cardDetail" and isinstance(data, dict) and card_id(data):
            items = [data]
        if items is None:
            return None
        if any(card_id(item) is None or not safe_card(item)["status"] for item in items):
            return None
        return {"total": data.get("total") if isinstance(data, dict) else None,
                "count": len(items), "cards": [safe_card(item) for item in items]}
    if operation in ("cardTransaction", "getCardFlow", "getSubscriptionList"):
        items = rows(data)
        if items is None:
            return None
        summary: dict[str, Any] = {"count": len(items), "total": data.get("total") if isinstance(data, dict) else None}
        if operation == "getSubscriptionList":
            summary["statuses"] = [str(item.get("status") or "")[:32] for item in items]
        return summary
    if operation == "getSubscription":
        if not isinstance(data, dict):
            return None
        return {key: data.get(key) for key in (
            "task_no", "client_order_no", "plan_type", "status", "upstream_status",
            "subscription_succeeded", "card_id", "query_source",
        ) if key in data}
    return None


def run_checks(client: OrbitcardClient, config: dict[str, Any]) -> dict[str, Any]:
    report: dict[str, Any] = {"base_url": config["base_url"], "read_only": True, "checks": []}
    checks: list[dict[str, Any]] = report["checks"]
    blocked = False

    def check(operation: str, body: dict[str, Any] | None = None) -> Any:
        nonlocal blocked
        if blocked:
            checks.append({"operation": operation, "status": "skipped", "reason": "认证失败或平台限流"})
            return None
        response = client.request(operation, body)
        item: dict[str, Any] = {"operation": operation, "status": "ok" if response.get("ok") else "failed"}
        if body:
            item["parameters"] = {key: value for key, value in body.items()
                                  if key in ("plan_type", "card_id", "card_ids", "type", "page", "page_size")}
        for key in ("http_status", "code", "error", "retry_after"):
            if key in response:
                item[key] = response[key]
        if response.get("ok"):
            summary = summarize(operation, response.get("data"))
            if summary is None:
                item.update(status="failed", error="成功响应的数据结构与文档不符")
            else:
                item["summary"] = summary
                if operation == "cardDetail" and body:
                    expected = set(body.get("card_ids") or [body.get("card_id")])
                    actual = {card["card_id"] for card in summary["cards"]}
                    if expected != actual:
                        item.update(status="failed", error="卡片详情缺项或卡 ID 归属不一致")
                        item["summary"] = {"requested": len(expected), "returned": len(actual)}
                if operation == "getSubscriptionPaymentRegions" and body and summary["plan_type"] != body["plan_type"]:
                    item.update(status="failed", error="支付地区返回的套餐与请求不一致")
        if response.get("http_status") in (401, 429):
            blocked = True
        checks.append(item)
        return response.get("data") if item["status"] == "ok" else None

    check("getAccountBalance")
    check("getProductCode")
    plans = check("getSubscriptionPlans")
    check("getSubscriptionCatalog")
    plan_types = []
    if isinstance(plans, dict) and isinstance(plans.get("plans"), list):
        plan_types = list(dict.fromkeys(str(plan.get("type")) for plan in plans["plans"]
                                            if isinstance(plan, dict) and plan.get("type") in PAYMENT_PLAN_TYPES))
    for plan_type in plan_types:
        check("getSubscriptionPaymentRegions", {"plan_type": plan_type})
    if not plan_types:
        checks.append({"operation": "getSubscriptionPaymentRegions", "status": "skipped",
                       "reason": "没有返回已启用的会员套餐"})

    max_cards = config["max_cards"]
    found: list[dict[str, Any]] = []
    page_size = min(100, max_cards)
    for page in range(1, (max_cards + page_size - 1) // page_size + 1):
        data = check("getCardList", {"page": page, "page_size": page_size})
        if data is None:
            break
        batch = rows(data)
        if batch is None:
            break
        found.extend(batch)
        total = data.get("total") if isinstance(data, dict) else None
        if len(batch) < page_size or len(found) >= max_cards or (positive_int(total) and len(found) >= int(total)):
            break
    ids = list(dict.fromkeys(value for card in found if (value := card_id(card)) is not None))[:max_cards]
    report["card_scan"] = {"listed": len(ids), "limit": max_cards,
                           "platform_total": total if found and isinstance(data, dict) else None,
                           "truncated": bool(found and isinstance(data, dict) and positive_int(total) and int(total) > len(ids))}
    for start in range(0, len(ids), 20):
        check("cardDetail", {"card_ids": ids[start:start + 20], "reveal_sensitive": False})
    selected_id = config["card_id"] or (ids[0] if ids else None)
    if selected_id:
        check("cardDetail", {"card_id": selected_id, "reveal_sensitive": False})
        check("cardTransaction", {"card_id": selected_id, "page": 1, "page_size": 20})
        for flow_type in ("recharge", "refund"):
            check("getCardFlow", {"card_id": selected_id, "type": flow_type, "page": 1, "page_size": 20})
    else:
        checks.append({"operation": "cardDetail/cardTransaction/getCardFlow", "status": "skipped",
                       "reason": "卡列表为空，且配置中未提供 card_id"})
    check("getSubscriptionList", {"page": 1, "page_size": 20})
    if config["task_no"] or config["client_order_no"]:
        check("getSubscription", {"task_no": config["task_no"]} if config["task_no"] else
              {"client_order_no": config["client_order_no"]})
    else:
        checks.append({"operation": "getSubscription", "status": "skipped",
                       "reason": "配置中未提供 task_no 或 client_order_no"})
    report["passed"] = sum(item["status"] == "ok" for item in checks)
    report["failed"] = sum(item["status"] == "failed" for item in checks)
    report["skipped"] = sum(item["status"] == "skipped" for item in checks)
    return report


def run_product_check(client: OrbitcardClient, config: dict[str, Any]) -> dict[str, Any]:
    response = client.request("getProductCode", {})
    summary = summarize("getProductCode", response.get("data")) if response.get("ok") else None
    result: dict[str, Any] = {"base_url": config["base_url"], "read_only": True,
                              "operation": "getProductCode", "status": "ok" if summary else "failed"}
    if summary:
        result["summary"] = summary
    else:
        result["error"] = response.get("error") or "成功响应的数据结构与文档不符"
        if "http_status" in response:
            result["http_status"] = response["http_status"]
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="只读检查 Orbitcard Open API，不执行资金或订阅写操作")
    parser.add_argument("--config", type=Path, required=True, help="JSON 配置文件路径；可放在项目外")
    parser.add_argument("--products-only", action="store_true", help="只检查 getProductCode 及套餐价格字段")
    parser.add_argument("--timeout", type=float, default=30.0, help="单次请求超时秒数，默认 30")
    args = parser.parse_args(argv)
    if not 1 <= args.timeout <= 60:
        parser.error("--timeout 必须在 1–60 秒之间")
    try:
        config = load_config(args.config)
    except ValueError as exc:
        print(f"配置错误：{exc}", file=sys.stderr)
        return 3
    client = OrbitcardClient(config, args.timeout)
    report = run_product_check(client, config) if args.products_only else run_checks(client, config)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.products_only:
        return 0 if report["status"] == "ok" else 2
    return 2 if report["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
