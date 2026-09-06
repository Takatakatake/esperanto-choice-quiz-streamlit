"""Existing public URLs keep their language and quiz mode in the unified UI."""

import importlib
import unittest
from unittest.mock import patch

import unified_app

ENTRIES = {
    "app": ("ja", "vocab"),
    "app_Cxina_versio": ("zh", "vocab"),
    "app_Korea_versio": ("ko", "vocab"),
    "sentence_app": ("ja", "sentence"),
    "sentence_app_Cxina_versio": ("zh", "sentence"),
    "sentence_app_Korea_versio": ("ko", "sentence"),
}


class EntryRoutingTests(unittest.TestCase):
    def check_routes(self, query, override=None):
        for name, (language, default) in ENTRIES.items():
            with self.subTest(entry=name, query=query), \
                 patch.object(unified_app.st, "query_params", query), \
                 patch.object(unified_app.st, "set_page_config") as configure, \
                 patch.object(unified_app, "render_mobile_app_entry") as render:
                importlib.import_module(name).main()
                mode = override or default
                render.assert_called_once_with(
                    source=f"{mode}_{language}", target_lang=language, default_mode=mode,
                )
                configure.assert_called_once()

    def test_each_entry_keeps_its_default_language_and_mode(self):
        self.check_routes({})

    def test_retired_classic_urls_open_the_unified_interface(self):
        self.check_routes({"classic": "1"})

    def test_explicit_quiz_urls_keep_selected_mode_on_every_entry(self):
        self.check_routes({"quiz": "sentence", "classic": "1"}, "sentence")
        self.check_routes({"quiz": "vocab", "mobile_app": "1"}, "vocab")

    def test_configuration_can_be_skipped_for_existing_embedders(self):
        with patch.object(unified_app.st, "query_params", {}), \
             patch.object(unified_app.st, "set_page_config") as configure, \
             patch.object(unified_app, "render_mobile_app_entry") as render:
            importlib.import_module("app").main(set_page_config_once=False)
            configure.assert_not_called()
            render.assert_called_once()


if __name__ == "__main__":
    unittest.main()
