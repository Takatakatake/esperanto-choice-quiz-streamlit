"""LOCAL QA ONLY: real app/handlers backed exclusively by synthetic in-memory sheets.

Run from the repository root in a dedicated local process:
    streamlit run tests/fixtures/learning_app.py --server.address 127.0.0.1

Use ?lang=ja, ?lang=zh or ?lang=ko; ?quiz=sentence also works.
The store survives reruns and is shared by this process's browser tabs. Restart
the process to reset it. Never deploy this fixture as a production entry point.

Initial totals (overall / vocab / sentence):
    Review-A: 200 / 150 / 50, public; noun 120, legacy verb 30, travel/train 50.
    Review-B: 1200000 / 1000000 / 200000, private; progress remains readable.
    Review-Long (browser fixture): 7040 / 200 / 6840, private; 18 sentence
        categories with four subtopics each, ending with Time & Weather.
        Noun 120 includes beginner 20, intermediate 30, advanced 40,
        mixed beginner+intermediate 20, unknown level 10; verb beginner 80.
Other names start with zero points and the normal public default.
All seeded records use today's timestamp for the today/month ranking checks.
"""

from __future__ import annotations

import copy
import datetime
from pathlib import Path
import re
import sys
import threading
import uuid


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

import streamlit as st


class MemoryWorksheet:
    """The small RAW worksheet interface used by the actual persistence layer."""

    def __init__(self, title, headers, records):
        self.title = title
        self._lock = threading.RLock()
        self._values = [list(headers)] + [
            [self._cell(record.get(header)) for header in headers] for record in records
        ]

    @staticmethod
    def _cell(value):
        return "" if value is None else str(value)

    def get_all_values(self):
        with self._lock:
            return copy.deepcopy(self._values)

    def row_values(self, row_number):
        with self._lock:
            return list(self._values[row_number - 1]) if row_number <= len(self._values) else []

    def col_values(self, column_number):
        with self._lock:
            return [row[column_number - 1] if column_number <= len(row) else "" for row in self._values]

    def append_row(self, values, *, value_input_option):
        self._require_raw(value_input_option)
        with self._lock:
            self._values.append([self._cell(value) for value in values])

    @staticmethod
    def _require_raw(value_input_option):
        if value_input_option != "RAW":
            raise ValueError("Local fixture accepts RAW writes only")

    def _update_range(self, range_name, values):
        match = re.fullmatch(r"([A-Z]+)([1-9]\d*)(?::[A-Z]+[1-9]\d*)?", range_name)
        if match is None:
            raise ValueError("Unsupported local worksheet range")
        column = 0
        for letter in match[1]:
            column = column * 26 + ord(letter) - ord("A") + 1
        first_row = int(match[2]) - 1
        while len(self._values) < first_row + len(values):
            self._values.append([])
        for offset, input_row in enumerate(values):
            row = self._values[first_row + offset]
            row.extend([""] * max(0, column - 1 + len(input_row) - len(row)))
            row[column - 1:column - 1 + len(input_row)] = [self._cell(value) for value in input_row]

    def update(self, range_name, values, *, value_input_option):
        self._require_raw(value_input_option)
        with self._lock:
            self._update_range(range_name, values)

    def batch_update(self, updates, *, value_input_option):
        self._require_raw(value_input_option)
        with self._lock:
            for update in updates:
                self._update_range(update["range"], update["values"])


class MemorySheetStore:
    def __init__(self, *, include_long_history=False):
        self._cache_prefix = f"local-learning-fixture-{uuid.uuid4()}"
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        records = [
            {"user": "Review-A", "mode": "vocab", "pos": "noun", "points": 120, "save_id": "fixture-a-noun"},
            {"user": "Review-A", "group_id": "verb:beginner_1:g1", "points": 30, "save_id": "fixture-a-legacy"},
            {"user": "Review-A", "mode": "sentence", "topic": "travel", "subtopic": "train", "points": 50, "save_id": "fixture-a-sentence"},
            {"user": "Review-B", "mode": "vocab", "pos": "noun", "points": 1_000_000, "save_id": "fixture-b-noun"},
            {"user": "Review-B", "mode": "sentence", "topic": "conversation", "points": 200_000, "save_id": "fixture-b-sentence"},
        ]
        if include_long_history:
            topics = [
                "Basic Sentences", "General Conversation", "Emergencies", "Making Friends",
                "Dating", "Education", "Jobs", "Travel", "Other Transport", "Hotel",
                "Restaurant & Pub", "Food", "Shopping", "Leisure Time", "Services", "Health",
                "Communication Means", "Time & Weather",
            ]
            records.extend([
                {"user": "Review-Long", "mode": "vocab", "pos": "noun", "group_id": "noun:beginner_1:g1", "points": 20, "save_id": "fixture-long-noun-beginner"},
                {"user": "Review-Long", "mode": "vocab", "pos": "noun", "group_id": "noun:intermediate_2:g1", "points": 30, "save_id": "fixture-long-noun-intermediate"},
                {"user": "Review-Long", "mode": "vocab", "pos": "noun", "group_id": "noun:advanced_3:g1", "points": 40, "save_id": "fixture-long-noun-advanced"},
                {"user": "Review-Long", "mode": "vocab", "pos": "noun", "group_id": "noun:beginner_3+intermediate_1:g1", "points": 20, "save_id": "fixture-long-noun-mixed"},
                {"user": "Review-Long", "mode": "vocab", "pos": "noun", "points": 10, "save_id": "fixture-long-noun-unknown"},
                {"user": "Review-Long", "mode": "vocab", "pos": "verb", "group_id": "verb:beginner_2:g1", "points": 80, "save_id": "fixture-long-verb"},
            ])
            for topic_index, topic in enumerate(topics):
                subtopics = ["Calendar", "Telling the Time", "Time Expressions", "Weather"] if topic == "Time & Weather" else [
                    "Basics", "Conversation", "Practice", "Review",
                ]
                for subtopic_index, subtopic in enumerate(subtopics):
                    records.append({
                        "user": "Review-Long", "mode": "sentence", "topic": topic, "subtopic": subtopic,
                        "points": (len(topics) - topic_index) * 10,
                        "save_id": f"fixture-long-{topic_index}-{subtopic_index}",
                    })
        for record in records:
            record.update(ts=now, total=10, correct=10)
        headers = list(dict.fromkeys(key for record in records for key in record))
        stats_headers = ["user", "total_points", "last_updated"]
        self.sheets = {
            "Scores": MemoryWorksheet("Scores", headers, records),
            "UserStats": MemoryWorksheet("UserStats", stats_headers, [
                {"user": "Review-A", "total_points": 200, "last_updated": now},
                {"user": "Review-B", "total_points": 1_200_000, "last_updated": now},
            ]),
            "UserStatsSentence": MemoryWorksheet("UserStatsSentence", stats_headers, [
                {"user": "Review-A", "total_points": 50, "last_updated": now},
                {"user": "Review-B", "total_points": 200_000, "last_updated": now},
            ]),
            "UserSettings": MemoryWorksheet("UserSettings", ["user", "ranking_public", "updated_at"], [
                {"user": "Review-A", "ranking_public": "true", "updated_at": now},
                {"user": "Review-B", "ranking_public": "false", "updated_at": now},
            ]),
        }
        if include_long_history:
            self.sheets["UserStats"].append_row(["Review-Long", 7040, now], value_input_option="RAW")
            self.sheets["UserStatsSentence"].append_row(["Review-Long", 6840, now], value_input_option="RAW")
            self.sheets["UserSettings"].append_row(["Review-Long", "false", now], value_input_option="RAW")

    def open_worksheet(self, worksheet_name, *, refresh=False):
        # No fallback or credential lookup exists, including for unknown sheets.
        return self.sheets.get(worksheet_name), f"{self._cache_prefix}::{worksheet_name}"


@st.cache_resource(show_spinner=False)
def shared_fixture_store():
    # Every browser shares one store: the patched module-level opener must never
    # switch between different databases when concurrent Streamlit sessions rerun.
    return MemorySheetStore(include_long_history=True)


def run_fixture():
    import score_append_utils
    import mobile_streamlit_bridge
    from unified_app import run_app

    score_append_utils._open_worksheet = shared_fixture_store().open_worksheet
    # The normal bridge reads st.secrets for audio; keep this fixture local-only.
    mobile_streamlit_bridge._mobile_audio_config = lambda: {
        "enabled": True,
        "vocabBaseUrl": "./audio/",
        "sentenceBaseUrl": "./sentence-audio/",
        "driveDownloadBaseUrl": "",
        "useDriveManifest": False,
    }
    run_app(target_lang=str(st.query_params.get("lang", "ja")), default_mode="vocab")
    # Exercise the real iframe's responsive layout when the review browser's
    # outer window cannot be resized. This option exists only in the fixture.
    preview_width = str(st.query_params.get("preview_width", ""))
    if preview_width.isdigit() and 320 <= int(preview_width) <= 1600:
        st.markdown(
            '<style>iframe[title*="esperanto_mobile_pwa"]'
            f'{{max-width:{int(preview_width)}px !important;margin:auto !important;}}'
            '</style>', unsafe_allow_html=True,
        )
    # Browser regressions verify isolation before saving any synthetic result.
    st.markdown('<div data-local-learning-fixture="memory" hidden></div>', unsafe_allow_html=True)


if __name__ == "__main__":
    run_fixture()
