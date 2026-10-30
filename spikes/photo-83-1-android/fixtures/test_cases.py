"""Repeatable smoke tests for annotated *synthetic* Vision Lab fixtures.

No model scores are fabricated here; image quality / Recall@K requires
physical Android and real-photo tests.
"""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image
from generate import main as generate_main

ROOT=Path(__file__).resolve().parent

class FixturesTest(unittest.TestCase):
    def setUp(self):
        self.manifest=json.loads((ROOT/"cases.json").read_text(encoding="utf-8"))
        self.groups=self.manifest["groups"]
        self.cases=[c for g in self.groups for c in g["cases"]]

    def test_count_and_unique_ids(self):
        self.assertEqual(len(self.groups),8)
        self.assertEqual(len(self.cases),41)
        ids=[c["id"] for c in self.cases]
        self.assertEqual(len(ids),len(set(ids)))
        self.assertTrue(all(c["label"] in ("positive","negative","hard","reference") for c in self.cases))

    def test_relevance_is_predefined_not_inferred(self):
        for group in self.groups:
            self.assertGreaterEqual(len(group["cases"]),5)
            self.assertEqual(len([x for x in group["cases"] if x["label"]=="positive"]),1)
            self.assertTrue(group["query"])
            self.assertGreaterEqual(len([x for x in group["cases"] if x["label"] in ("hard","negative")]),3)

    def test_image_to_image_anchor_excluded_from_candidate_set(self):
        photos=next(g for g in self.groups if g["group"]=="IMAGE_TO_IMAGE")
        anchors=[x for x in photos["cases"] if x["label"]=="reference"]
        self.assertEqual(len(anchors),1)
        self.assertEqual(len(photos["cases"]),6)
        anchor=anchors[0]
        self.assertEqual(anchor["identity"],"A")
        self.assertEqual(
            [x["id"] for x in photos["cases"] if x["label"]=="positive"],
            ["candidate_bike_A_angle"]
        )
        self.assertNotEqual(anchor["id"],"candidate_bike_A_angle")

    def test_generator_produces_real_individual_jpeg_bytes_without_labels(self):
        from generate import render
        hashes=set()
        for example in self.cases:
            group=next(g["group"] for g in self.groups if example in g["cases"])
            image=render({**example,"group":group})
            self.assertEqual(image.size,(640,440))
            self.assertEqual(image.mode,"RGB")
            with tempfile.TemporaryDirectory() as td:
                target=Path(td)/"fixture.jpg"
                image.save(target,format="JPEG",quality=88)
                with Image.open(target) as decoded:
                    self.assertEqual(decoded.format,"JPEG")
                    self.assertEqual(decoded.size,(640,440))
                self.assertNotIn(b"red bicycle near",target.read_bytes())
                hashes.add(hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertEqual(len(hashes),41)

if __name__=="__main__":
    unittest.main()
