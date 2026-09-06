from __future__ import annotations

import time
from typing import Dict, Optional

import gspread
import streamlit as st
from gspread.utils import rowcol_to_a1

from score_row_utils import SENTENCE_MODE, VOCAB_MODE, infer_mode, iter_unique_score_rows


_CREDENTIAL_KEYS = {
    "type",
    "project_id",
    "private_key_id",
    "private_key",
    "client_email",
    "client_id",
    "auth_uri",
    "token_uri",
    "auth_provider_x509_cert_url",
    "client_x509_cert_url",
    "universe_domain",
}

_WS_CACHE: Dict[str, gspread.Worksheet] = {}
_HEADER_CACHE: Dict[str, list[str]] = {}
_RECENT_SAVE_IDS: Dict[str, set[str]] = {}
_RECENT_SAVE_IDS_LIMIT = 2048
_STATS_REQUIRED_HEADERS = ["user", "total_points", "last_updated"]


def _to_plain_dict(value) -> Dict:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    try:
        return dict(value)
    except Exception:
        return {}


def _get_conn_config() -> Dict:
    try:
        secrets = st.secrets
    except Exception:
        return {}
    conn = _to_plain_dict(_to_plain_dict(secrets).get("connections", {}).get("gsheets"))
    return conn


def _build_cache_key(conn: Dict, worksheet_name: str) -> Optional[str]:
    target = str(conn.get("spreadsheet") or conn.get("spreadsheet_url") or "").strip()
    if not target:
        return None
    return f"{target}::{worksheet_name}"


def _open_worksheet(worksheet_name: str, *, refresh: bool = False) -> tuple[Optional[gspread.Worksheet], Optional[str]]:
    conn = _get_conn_config()
    if not conn:
        return None, None
    cache_key = _build_cache_key(conn, worksheet_name)
    if cache_key is None:
        return None, None

    target = cache_key.split("::", 1)[0]
    if refresh and cache_key:
        _WS_CACHE.pop(cache_key, None)
        _HEADER_CACHE.pop(cache_key, None)
    cached = _WS_CACHE.get(cache_key)
    if cached is not None:
        return cached, cache_key

    creds = {k: conn.get(k) for k in _CREDENTIAL_KEYS if conn.get(k)}
    if not creds:
        return None, cache_key

    try:
        client = gspread.service_account_from_dict(creds)
        client.set_timeout((5, 20))
        if target.startswith("http://") or target.startswith("https://"):
            ss = client.open_by_url(target)
        else:
            ss = client.open_by_key(target)
        ws = ss.worksheet(worksheet_name)
        _WS_CACHE[cache_key] = ws
        return ws, cache_key
    except Exception:
        return None, cache_key


def _invalidate_cache(cache_key: Optional[str]) -> None:
    if not cache_key:
        return
    _WS_CACHE.pop(cache_key, None)
    _HEADER_CACHE.pop(cache_key, None)
    _RECENT_SAVE_IDS.pop(cache_key, None)


def _safe_float(value, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        if isinstance(value, str) and not value.strip():
            return default
        parsed = float(value)
        if parsed != parsed or parsed in (float("inf"), float("-inf")):
            return default
        return parsed
    except (TypeError, ValueError):
        return default


def _load_headers(ws: gspread.Worksheet, cache_key: Optional[str], *, refresh: bool = False) -> list[str]:
    if not refresh and cache_key:
        cached = _HEADER_CACHE.get(cache_key)
        if cached:
            return list(cached)
    headers = [str(h).strip() for h in ws.row_values(1)]
    if cache_key:
        _HEADER_CACHE[cache_key] = list(headers)
    return headers


def _write_header_row(ws: gspread.Worksheet, cache_key: Optional[str], headers: list[str]) -> list[str]:
    # Empty header cells still occupy columns containing historical row data.
    normalized = [str(h).strip() for h in headers]
    if not any(normalized):
        return []
    end_cell = rowcol_to_a1(1, len(normalized))
    ws.update(f"A1:{end_cell}", [normalized], value_input_option="RAW")
    if cache_key:
        _HEADER_CACHE[cache_key] = list(normalized)
    return normalized


def _ensure_headers(ws: gspread.Worksheet, cache_key: Optional[str], required_headers) -> list[str]:
    required = [str(h).strip() for h in required_headers if str(h).strip()]
    headers = _load_headers(ws, cache_key)
    if not headers:
        return _write_header_row(ws, cache_key, required)
    missing = [h for h in required if h not in headers]
    if not missing:
        return headers
    fresh_headers = _load_headers(ws, cache_key, refresh=True)
    missing = [h for h in required if h not in fresh_headers]
    if not missing:
        return fresh_headers
    return _write_header_row(ws, cache_key, fresh_headers + missing)


def _row_from_headers(record: Dict, headers: list[str]) -> list[str]:
    return ["" if record.get(h) is None else str(record.get(h)) for h in headers]


def _read_sheet_values(ws: gspread.Worksheet) -> list[list[str]]:
    values = ws.get_all_values()
    return values if values else []


def _read_records_from_values(values: list[list[str]]) -> list[Dict]:
    if not values:
        return []
    headers = [str(h).strip() for h in values[0]]
    if not headers:
        return []
    records = []
    for raw_row in values[1:]:
        row = list(raw_row) + [""] * max(0, len(headers) - len(raw_row))
        record = {}
        non_blank = False
        for idx, header in enumerate(headers):
            if not header:
                continue
            value = row[idx] if idx < len(row) else ""
            if str(value).strip():
                non_blank = True
            record[header] = value
        if non_blank:
            records.append(record)
    return records


def _save_id_exists(ws: gspread.Worksheet, headers, save_id: str) -> bool:
    if not save_id or "save_id" not in headers:
        return False
    try:
        col_idx = headers.index("save_id") + 1
        values = ws.col_values(col_idx)
    except Exception:
        return False
    return any(str(v).strip() == save_id for v in values[1:])


def _confirm_save_id_exists(
    ws: gspread.Worksheet,
    cache_key: Optional[str],
    headers,
    save_id: str,
    *,
    attempts: int = 3,
    delay_base_sec: float = 0.2,
) -> bool:
    if not save_id:
        return False
    if _save_id_exists(ws, headers, save_id):
        return True

    worksheet_name = getattr(ws, "title", "")
    for attempt in range(1, max(1, attempts)):
        time.sleep(delay_base_sec * attempt)
        retry_ws, retry_cache_key = _open_worksheet(worksheet_name, refresh=True)
        if retry_ws is None:
            continue
        retry_headers = headers
        try:
            retry_headers = _ensure_headers(retry_ws, retry_cache_key, headers)
        except Exception:
            pass
        if _save_id_exists(retry_ws, retry_headers, save_id):
            return True
    if cache_key:
        _HEADER_CACHE.pop(cache_key, None)
    return False


def _append_score_row_once(record: Dict, worksheet_name: str, *, refresh: bool) -> Optional[bool]:
    ws, cache_key = _open_worksheet(worksheet_name, refresh=refresh)
    if ws is None:
        return None

    try:
        headers = _ensure_headers(ws, cache_key, list(record.keys()))
    except Exception:
        _invalidate_cache(cache_key)
        return None
    if not headers:
        return None

    save_id = str(record.get("save_id", "")).strip()
    recent_ids = _RECENT_SAVE_IDS.setdefault(cache_key or "__default__", set())
    if save_id and save_id in recent_ids:
        return True
    if save_id and _save_id_exists(ws, headers, save_id):
        recent_ids.add(save_id)
        return True

    row = _row_from_headers(record, headers)
    try:
        ws.append_row(row, value_input_option="RAW")
        if save_id:
            recent_ids.add(save_id)
            if len(recent_ids) > _RECENT_SAVE_IDS_LIMIT:
                recent_ids.clear()
                recent_ids.add(save_id)
        return True
    except Exception:
        if save_id and _confirm_save_id_exists(ws, cache_key, headers, save_id):
            recent_ids.add(save_id)
            return True
        _invalidate_cache(cache_key)
        return False


def append_score_row_fast(record: Dict, worksheet_name: str) -> Optional[bool]:
    """
    Fast-path append for Scores sheet.

    Returns:
      - True: append succeeded or idempotent duplicate already exists
      - False: attempted but failed (caller may retry/fallback)
      - None: fast path unavailable; caller should fallback
    """
    return _append_score_row_once(record, worksheet_name, refresh=False)


def append_score_row_safe(
    record: Dict,
    worksheet_name: str,
    *,
    retries: int = 3,
    retry_base_sec: float = 0.4,
) -> bool:
    last_result: Optional[bool] = None
    for attempt in range(max(1, retries)):
        result = _append_score_row_once(record, worksheet_name, refresh=True)
        if result is True:
            return True
        last_result = result
        if attempt + 1 < max(1, retries):
            time.sleep(retry_base_sec * (attempt + 1))
    return bool(last_result)


def load_sheet_records(
    worksheet_name: str, *, refresh: bool = False, required_headers=()
) -> Optional[list[Dict]]:
    ws, cache_key = _open_worksheet(worksheet_name, refresh=refresh)
    if ws is None:
        return None
    try:
        values = _read_sheet_values(ws)
        headers = [str(h).strip() for h in values[0]] if values else []
        if any(headers.count(header) != 1 for header in required_headers):
            _invalidate_cache(cache_key)
            return None
        if refresh and cache_key:
            _HEADER_CACHE[cache_key] = headers
        return _read_records_from_values(values)
    except Exception:
        _invalidate_cache(cache_key)
        return None


def compute_user_score_totals(records, user: str) -> Dict[str, float]:
    normalized_user = str(user).strip()
    totals = {"overall": 0.0, "vocab": 0.0, "sentence": 0.0}
    if not normalized_user:
        return totals
    for row in iter_unique_score_rows(records):
        if str(row.get("user", "")).strip() != normalized_user:
            continue
        points = _safe_float(row.get("points", 0.0), 0.0)
        mode = infer_mode(row, fallback=VOCAB_MODE)
        totals["overall"] += points
        if mode == SENTENCE_MODE:
            totals["sentence"] += points
        else:
            totals["vocab"] += points
    return totals


def upsert_user_total(
    worksheet_name: str,
    *,
    user: str,
    total_points: float,
    last_updated: str,
    retries: int = 3,
    retry_base_sec: float = 0.4,
) -> bool:
    normalized_user = str(user).strip()
    if not normalized_user:
        return True

    last_error = None
    attempts = max(1, retries)
    expected_total = _safe_float(total_points, 0.0)
    for attempt in range(attempts):
        ws, cache_key = _open_worksheet(worksheet_name, refresh=(attempt > 0))
        if ws is None:
            last_error = RuntimeError(f"{worksheet_name} worksheet is unavailable")
        else:
            try:
                headers = _ensure_headers(ws, cache_key, _STATS_REQUIRED_HEADERS)
                if not headers:
                    raise RuntimeError(f"{worksheet_name} headers are unavailable")
                user_idx = headers.index("user")
                total_idx = headers.index("total_points")
                values = _read_sheet_values(ws)
                existing_rows = []
                current_max_total = None
                for row_number, row in enumerate(values[1:], start=2):
                    current_user = row[user_idx].strip() if user_idx < len(row) else ""
                    if current_user == normalized_user:
                        existing_rows.append(row_number)
                        current_total = _safe_float(row[total_idx] if total_idx < len(row) else 0.0, 0.0)
                        if current_max_total is None or current_total > current_max_total:
                            current_max_total = current_total
                target_total = expected_total
                if current_max_total is not None and current_max_total > target_total:
                    # A lower log snapshot does not prove older totals are wrong
                    # or that the entire historical log is present. Never repair
                    # a user's accumulated points downward during an ordinary save.
                    target_total = current_max_total
                row_values = _row_from_headers(
                    {
                        "user": normalized_user,
                        "total_points": target_total,
                        "last_updated": last_updated,
                    },
                    headers,
                )
                if existing_rows:
                    for row_number in existing_rows:
                        start_cell = rowcol_to_a1(row_number, 1)
                        end_cell = rowcol_to_a1(row_number, len(headers))
                        ws.update(f"{start_cell}:{end_cell}", [row_values], value_input_option="RAW")
                else:
                    ws.append_row(row_values, value_input_option="RAW")

                verify_records = load_sheet_records(worksheet_name, refresh=True)
                if verify_records is None:
                    raise RuntimeError(f"{worksheet_name} verification read failed")
                for record in verify_records:
                    if str(record.get("user", "")).strip() != normalized_user:
                        continue
                    actual_total = _safe_float(record.get("total_points"), 0.0)
                    if abs(actual_total - target_total) <= 0.001 or actual_total > target_total:
                        return True
                raise RuntimeError(f"{worksheet_name} verification could not confirm {normalized_user}")
            except Exception as exc:
                last_error = exc
                _invalidate_cache(cache_key)
        if attempt + 1 < attempts:
            time.sleep(retry_base_sec * (attempt + 1))
    return False
