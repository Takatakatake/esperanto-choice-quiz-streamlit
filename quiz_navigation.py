"""Resolve existing quiz URLs without maintaining separate device interfaces."""

import streamlit as st


MODE_ALIASES = {
    "vocab": "vocab",
    "word": "vocab",
    "words": "vocab",
    "token": "vocab",
    "tokens": "vocab",
    "単語": "vocab",
    "語彙": "vocab",
    "sentence": "sentence",
    "sentences": "sentence",
    "phrase": "sentence",
    "phrases": "sentence",
    "例文": "sentence",
    "文章": "sentence",
}


def get_quiz_mode(default: str = "vocab") -> str:
    fallback = "sentence" if default == "sentence" else "vocab"
    for key in ("quiz", "mode", "view"):
        raw = str(st.query_params.get(key, "")).strip().lower()
        if raw:
            return MODE_ALIASES.get(raw, fallback)
    return fallback
