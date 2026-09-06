"""Shared Streamlit host; quizzes run in the browser on every device."""

import streamlit as st

from mobile_streamlit_bridge import render_mobile_app_entry
from quiz_navigation import get_quiz_mode


PAGE_TITLES = {
    "ja": "エスペラント学習",
    "zh": "世界语学习",
    "ko": "에스페란토 학습",
}


def run_app(
    *,
    target_lang: str = "ja",
    default_mode: str = "vocab",
    set_page_config_once: bool = True,
) -> None:
    lang = target_lang if target_lang in PAGE_TITLES else "ja"
    mode = get_quiz_mode(default=default_mode)
    if set_page_config_once:
        st.set_page_config(
            page_title=PAGE_TITLES[lang],
            page_icon="💚",
            layout="wide",
            initial_sidebar_state="collapsed",
        )
    # Keep the existing component identity so saved browser sessions remain usable.
    render_mobile_app_entry(
        source=f"{mode}_{lang}",
        target_lang=lang,
        default_mode=mode,
    )
