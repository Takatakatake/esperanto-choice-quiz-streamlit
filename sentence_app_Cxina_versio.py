"""Stable Streamlit entry point for the shared Esperanto learning app."""

from unified_app import run_app


def main(set_page_config_once: bool = True):
    run_app(
        target_lang="zh",
        default_mode="sentence",
        set_page_config_once=set_page_config_once,
    )


if __name__ == "__main__":
    main()
