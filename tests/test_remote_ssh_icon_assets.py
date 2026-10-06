from __future__ import annotations

import json
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


class RemoteSshIconAssetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(__file__).resolve().parents[1]
        cls.plugin_root = cls.root / "apps" / "codex-remote-ssh"

    def test_manifest_icon_assets_are_square_and_at_least_48_px(self) -> None:
        manifest = json.loads(
            (self.plugin_root / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
        )
        interface = manifest["interface"]

        for field in ("composerIcon", "composerIconDark", "logo", "logoDark"):
            relative = interface[field]
            self.assertTrue(relative.startswith("./"), field)
            asset = self.plugin_root / relative.removeprefix("./")
            self.assertTrue(asset.is_file(), f"{field}: missing {asset}")

            svg = ET.parse(asset).getroot()
            view_box = [float(value) for value in svg.attrib["viewBox"].split()]
            self.assertEqual(len(view_box), 4, field)
            width = view_box[2]
            height = view_box[3]
            self.assertEqual(width, height, field)
            self.assertGreaterEqual(width, 48, field)

            declared_width = float(svg.attrib["width"])
            declared_height = float(svg.attrib["height"])
            self.assertEqual(declared_width, declared_height, field)
            self.assertGreaterEqual(declared_width, 48, field)


if __name__ == "__main__":
    unittest.main()
