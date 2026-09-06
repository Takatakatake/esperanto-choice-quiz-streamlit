import tempfile
import unittest
from pathlib import Path

from tools.update_mobile_version import update_mobile_version


class UpdateMobileVersionTests(unittest.TestCase):
    version = "2026-09-06-release-4"

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "mobile_app").mkdir()
        self.files = {
            "mobile_app/app.js": 'const APP_VERSION = "2026-09-06-release-3";\nconst keep = true;\n',
            "mobile_app/index.html": '<link rel="stylesheet" href="./styles.css">\n<p>Keep this</p>\n',
            "mobile-sw.js": 'const CACHE_VERSION = "esperanto-mobile-pwa-2026-09-06-release-3";\n'
                'const APP_SHELL = ["./mobile_app/index.html", "./mobile_app/styles.css"];\n',
        }
        for name, content in self.files.items():
            (self.root / name).write_text(content, encoding="utf-8")

    def snapshot(self):
        return {name: (self.root / name).read_bytes() for name in self.files}

    def test_updates_app_stylesheet_and_precache_to_the_same_release(self):
        changed = update_mobile_version(self.version, root=self.root)
        self.assertEqual(len(changed), 3)
        app = (self.root / "mobile_app/app.js").read_text()
        index = (self.root / "mobile_app/index.html").read_text()
        worker = (self.root / "mobile-sw.js").read_text()
        self.assertIn(f'const APP_VERSION = "{self.version}";', app)
        self.assertIn(f'href="./styles.css?v={self.version}"', index)
        self.assertIn(f'const CACHE_VERSION = "esperanto-mobile-pwa-{self.version}";', worker)
        self.assertIn(f'"./mobile_app/styles.css?v={self.version}"', worker)
        self.assertIn("const keep = true;", app)
        self.assertIn("<p>Keep this</p>", index)
        before = self.snapshot()
        self.assertEqual(update_mobile_version(self.version, root=self.root), [])
        self.assertEqual(self.snapshot(), before)

    def test_repairs_asset_versions_even_if_app_version_already_matches(self):
        update_mobile_version(self.version, root=self.root)
        for name in ("mobile_app/index.html", "mobile-sw.js"):
            path = self.root / name
            path.write_text(path.read_text().replace(self.version, "2026-08-01-old"))
        changed = update_mobile_version(self.version, root=self.root)
        self.assertEqual({path.name for path in changed}, {"index.html", "mobile-sw.js"})
        self.assertNotIn(b"2026-08-01-old", b"".join(self.snapshot().values()))

    def test_missing_version_location_leaves_every_file_unchanged(self):
        locations = [
            ("mobile_app/app.js", "APP_VERSION"),
            ("mobile_app/index.html", "styles.css"),
            ("mobile-sw.js", "CACHE_VERSION"),
            ("mobile-sw.js", "styles.css"),
        ]
        for name, marker in locations:
            with self.subTest(name=name, marker=marker):
                path = self.root / name
                original = path.read_text()
                path.write_text(original.replace(marker, "missing"))
                before = self.snapshot()
                with self.assertRaises(ValueError):
                    update_mobile_version(self.version, root=self.root)
                self.assertEqual(self.snapshot(), before)
                path.write_text(original)

    def test_ambiguous_stylesheet_location_does_not_partially_update_files(self):
        path = self.root / "mobile_app/index.html"
        path.write_text(path.read_text() + '<link rel="stylesheet" href="./styles.css">\n')
        before = self.snapshot()
        with self.assertRaises(ValueError):
            update_mobile_version(self.version, root=self.root)
        self.assertEqual(self.snapshot(), before)

    def test_invalid_version_leaves_every_file_unchanged(self):
        before = self.snapshot()
        for version in ("", "release-4", "2026-09-06-a&other=1", '2026-09-06-a"'):
            with self.subTest(version=version):
                with self.assertRaises(ValueError):
                    update_mobile_version(version, root=self.root)
                self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
