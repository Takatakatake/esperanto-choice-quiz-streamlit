from __future__ import annotations

import time
import uuid
from typing import Dict, Optional

from score_append_utils import (
    append_score_row_fast,
    append_score_row_safe,
    compute_user_score_totals,
    load_sheet_records,
    upsert_user_total,
)
from score_row_utils import SENTENCE_MODE, VOCAB_MODE, infer_mode, normalize_score_row


SCORES_SHEET = "Scores"
USER_STATS_SHEET = "UserStats"
USER_STATS_SENTENCE_SHEET = "UserStatsSentence"
SCORE_WRITE_RETRIES = 3
SCORE_WRITE_RETRY_BASE_SEC = 0.4


def append_score_record(
    record: Dict,
    *,
    fallback_mode: str = VOCAB_MODE,
    worksheet_name: str = SCORES_SHEET,
    retries: int = SCORE_WRITE_RETRIES,
    retry_base_sec: float = SCORE_WRITE_RETRY_BASE_SEC,
) -> bool:
    """Append a score row idempotently to the canonical score log."""
    record_to_save = normalize_score_row(record, fallback_mode=fallback_mode)
    save_id = str(record_to_save.get("save_id", "")).strip()
    record_to_save["save_id"] = save_id or str(uuid.uuid4())

    fast_saved = append_score_row_fast(record_to_save, worksheet_name=worksheet_name)
    if fast_saved is True:
        return True
    return append_score_row_safe(
        record_to_save,
        worksheet_name=worksheet_name,
        retries=retries,
        retry_base_sec=retry_base_sec,
    )


def load_score_records_for_totals(
    *,
    worksheet_name: str = SCORES_SHEET,
    retries: int = SCORE_WRITE_RETRIES,
    retry_base_sec: float = SCORE_WRITE_RETRY_BASE_SEC,
) -> Optional[list[Dict]]:
    """Read the canonical score log with short retries for total recomputation."""
    for attempt in range(max(1, retries)):
        records = load_sheet_records(worksheet_name, refresh=True, required_headers=("user", "points"))
        if records is not None:
            return records
        if attempt + 1 < max(1, retries):
            time.sleep(retry_base_sec * (attempt + 1))
    return None


def load_score_totals_for_user(user: str, records=None) -> Optional[Dict[str, float]]:
    """Compute overall/vocab/sentence totals for one user from Scores."""
    source_records = records
    if source_records is None:
        source_records = load_score_records_for_totals()
    if source_records is None:
        return None
    return compute_user_score_totals(source_records, user)


def update_user_stats_totals(
    *,
    user: str,
    last_updated: str,
    totals: Optional[Dict[str, float]] = None,
    update_sentence_stats: bool = False,
    retries: int = SCORE_WRITE_RETRIES,
    retry_base_sec: float = SCORE_WRITE_RETRY_BASE_SEC,
) -> tuple[bool, bool]:
    """Upsert aggregate sheets derived from Scores.

    Returns (overall_ok, sentence_ok). The sentence result is True when the
    sentence-only sheet was not requested.
    """
    current_totals = totals if totals is not None else load_score_totals_for_user(user)
    if current_totals is None:
        sentence_ok = False if update_sentence_stats else True
        return False, sentence_ok

    overall_ok = upsert_user_total(
        USER_STATS_SHEET,
        user=user,
        total_points=current_totals["overall"],
        last_updated=last_updated,
        retries=retries,
        retry_base_sec=retry_base_sec,
    )

    sentence_ok = True
    if update_sentence_stats:
        sentence_ok = upsert_user_total(
            USER_STATS_SENTENCE_SHEET,
            user=user,
            total_points=current_totals["sentence"],
            last_updated=last_updated,
            retries=retries,
            retry_base_sec=retry_base_sec,
        )
    return overall_ok, sentence_ok


def update_overall_user_stats(
    *,
    user: str,
    last_updated: str,
    totals: Optional[Dict[str, float]] = None,
    retries: int = SCORE_WRITE_RETRIES,
    retry_base_sec: float = SCORE_WRITE_RETRY_BASE_SEC,
) -> bool:
    overall_ok, _ = update_user_stats_totals(
        user=user,
        last_updated=last_updated,
        totals=totals,
        update_sentence_stats=False,
        retries=retries,
        retry_base_sec=retry_base_sec,
    )
    return overall_ok


def update_sentence_user_stats(
    *,
    user: str,
    last_updated: str,
    totals: Optional[Dict[str, float]] = None,
    retries: int = SCORE_WRITE_RETRIES,
    retry_base_sec: float = SCORE_WRITE_RETRY_BASE_SEC,
) -> bool:
    current_totals = totals if totals is not None else load_score_totals_for_user(user)
    if current_totals is None:
        return False
    return upsert_user_total(
        USER_STATS_SENTENCE_SHEET,
        user=user,
        total_points=current_totals["sentence"],
        last_updated=last_updated,
        retries=retries,
        retry_base_sec=retry_base_sec,
    )


def update_totals_for_record(record: Dict) -> tuple[bool, bool]:
    """Update aggregate sheets after a score row has been appended."""
    user = str(record.get("user") or "").strip()
    last_updated = str(record.get("ts") or record.get("completed_at") or "")
    update_sentence_stats = infer_mode(record, fallback=VOCAB_MODE) == SENTENCE_MODE
    return update_user_stats_totals(
        user=user,
        last_updated=last_updated,
        update_sentence_stats=update_sentence_stats,
    )
