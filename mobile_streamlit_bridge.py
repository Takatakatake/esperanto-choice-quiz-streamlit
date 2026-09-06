from __future__ import annotations

import logging
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

from quiz_navigation import get_quiz_mode
from mobile_ranking import load_mobile_rankings_request
from mobile_score_sync import save_mobile_score_request
from user_progress import load_user_progress_request
from user_settings import save_user_settings_request


BASE_DIR = Path(__file__).resolve().parent
MOBILE_APP_DIR = BASE_DIR / "mobile_app"
MOBILE_AUDIO_MANIFEST = MOBILE_APP_DIR / "data" / "audio_manifest.json"
DRIVE_AUDIO_DOWNLOAD_BASE = "https://drive.google.com/uc?export=download&id="
COMPONENT_VOCAB_AUDIO_BASE = "./audio/"
COMPONENT_SENTENCE_AUDIO_BASE = "./sentence-audio/"
SUPPORTED_MOBILE_LANGS = {"ja", "zh", "ko"}
logger = logging.getLogger(__name__)

_mobile_component = components.declare_component(
    "esperanto_mobile_pwa",
    path=str(MOBILE_APP_DIR),
)


def _mobile_audio_config() -> dict:
    try:
        config = dict(st.secrets.get("mobile_audio", {}))
    except Exception:
        config = {}
    vocab_base_url = str(config.get("vocab_base_url", "")).strip() or COMPONENT_VOCAB_AUDIO_BASE
    sentence_base_url = str(config.get("sentence_base_url", "")).strip() or COMPONENT_SENTENCE_AUDIO_BASE
    drive_download_base_url = str(config.get("drive_download_base_url", "")).strip() or DRIVE_AUDIO_DOWNLOAD_BASE
    manifest_available = MOBILE_AUDIO_MANIFEST.exists()
    enabled = bool(vocab_base_url or sentence_base_url or manifest_available)
    return {
        "enabled": enabled,
        "vocabBaseUrl": vocab_base_url,
        "sentenceBaseUrl": sentence_base_url,
        "driveDownloadBaseUrl": drive_download_base_url,
        "useDriveManifest": manifest_available,
    }


def _mobile_lang_from_source(source: str) -> str:
    suffix = str(source or "").rsplit("_", 1)[-1].lower()
    return suffix if suffix in SUPPORTED_MOBILE_LANGS else "ja"


def _mobile_mode_from_source(source: str) -> str:
    return "sentence" if str(source or "").startswith("sentence") else "vocab"


def render_mobile_app_entry(
    *,
    source: str,
    target_lang: str | None = None,
    default_mode: str | None = None,
) -> bool:
    """Render one browser UI for every device, including old classic URLs."""
    lang = str(target_lang or _mobile_lang_from_source(source)).strip().lower()
    if lang not in SUPPORTED_MOBILE_LANGS:
        lang = "ja"
    fallback_mode = str(default_mode or _mobile_mode_from_source(source)).strip().lower()
    if fallback_mode not in {"vocab", "sentence"}:
        fallback_mode = "vocab"
    mode = get_quiz_mode(default=fallback_mode)

    st.session_state.setdefault("mobile_score_sync_result", None)
    st.session_state.setdefault("mobile_ranking_result", None)
    st.session_state.setdefault("mobile_progress_result", None)
    st.session_state.setdefault("mobile_user_settings_result", None)
    st.session_state.setdefault("mobile_processed_requests", {})

    st.markdown(
        """
        <style>
        div[data-testid="stToolbar"], div[data-testid="stDecoration"],
        header[data-testid="stHeader"], #MainMenu, footer {
            display: none !important;
        }
        div[data-testid="stAppViewContainer"] {
            background: #f7f8f4 !important;
        }
        section[data-testid="stSidebar"] {
            display: none !important;
        }
        .block-container {
            max-width: 100% !important;
            padding: 0 !important;
        }
        iframe[title*="esperanto_mobile_pwa"] {
            display: block !important;
            width: 100% !important;
            min-height: 640px !important;
            border: 0 !important;
        }
        div[data-testid="stVerticalBlock"],
        div[data-testid="stVerticalBlock"] > div,
        div[data-testid="stElementContainer"] {
            gap: 0 !important;
            margin: 0 !important;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )
    component_value = _mobile_component(
        source=source,
        mobileConfig={
            "source": source,
            "targetLang": lang,
            "defaultMode": mode,
        },
        scoreSyncResult=st.session_state.mobile_score_sync_result,
        rankingResult=st.session_state.mobile_ranking_result,
        progressResult=st.session_state.mobile_progress_result,
        userSettingsResult=st.session_state.mobile_user_settings_result,
        audioConfig=_mobile_audio_config(),
        default=None,
        key=f"esperanto_mobile_pwa_{source}",
        height=900,
    )
    _process_request(component_value, lang)
    return True


def _process_request(payload, lang: str) -> None:
    if not isinstance(payload, dict):
        return
    handlers = {
        "save_score": ("mobile_score_sync_result", "score_save_result", save_mobile_score_request),
        "load_rankings": ("mobile_ranking_result", "rankings_result", load_mobile_rankings_request),
        "load_progress": ("mobile_progress_result", "progress_result", load_user_progress_request),
        "save_user_settings": (
            "mobile_user_settings_result", "user_settings_result", save_user_settings_request,
        ),
    }
    request_type = payload.get("type")
    if not isinstance(request_type, str) or request_type not in handlers:
        return
    request_id = payload.get("requestId")
    if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 200:
        return
    processed = st.session_state.mobile_processed_requests
    key = (request_type, request_id)
    if key in processed:
        return
    state_key, result_type, handler = handlers[request_type]
    try:
        # Never reuse a personalized or visibility-filtered response for another request.
        result = handler(payload)
    except Exception:
        logger.exception("Learning request failed: %s", request_type)
        messages = {
            "ja": "処理できませんでした。しばらくしてから再試行してください。",
            "zh": "暂时无法完成操作，请稍后重试。",
            "ko": "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        }
        result = {
            "type": result_type,
            "requestId": request_id,
            "user": payload.get("user") if isinstance(payload.get("user"), str) else "",
            "saveId": payload.get("saveId", ""),
            "ok": False,
            "message": messages.get(lang, messages["ja"]),
        }
    st.session_state[state_key] = result
    processed[key] = True
    if request_type == "save_user_settings" or (request_type == "save_score" and result.get("ok")):
        st.session_state.mobile_ranking_result = None
        st.session_state.mobile_progress_result = None
    if len(processed) > 100:
        for old_key in list(processed)[:-100]:
            processed.pop(old_key, None)
    st.rerun()
