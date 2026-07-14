#!/usr/bin/env python3
"""
Audit the 3-scene chemistry video outline file.

This is a deterministic preflight checker. It does not rewrite content and it
does not call an AI model. Its job is to flag dialogue and image prompts that
violate the project rules before we generate images from them.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path


OUTLINE_RE = re.compile(
    r"^### (?P<number>\d+)\. (?P<title>.+?) - (?P<object>.+?)\s*$",
    re.MULTILINE,
)
SCENE_RE = re.compile(r"^\*\*Scene (?P<scene>[123]) image:\*\* (?P<text>.+)$")
DIALOGUE_RE = re.compile(r'^\*\*Dialogue:\*\* "(?P<text>.+)"$')


BAD_DIALOGUE_PHRASES = [
    "ordinary object",
    "chemistry starts",
    "in real jobs",
    "small lesson",
    "stuff has properties",
    "hiding in plain sight",
    "real-world chemistry",
    "everyday chemistry",
    "chemistry is everywhere",
    "materials matter",
    "makes science feel real",
    "big idea",
    "the lesson sneaks in",
    "not magic",
]

FLUFF_WORDS = {
    "ordinary",
    "surprising",
    "simple",
    "real",
    "stuff",
    "things",
    "interesting",
    "powerful",
    "cool",
    "useful",
    "matter",
}

SCIENCE_TERMS = {
    "acid",
    "base",
    "bond",
    "carbon",
    "charge",
    "compound",
    "concentration",
    "dissolve",
    "electron",
    "element",
    "energy",
    "ethanol",
    "evaporate",
    "gas",
    "ion",
    "liquid",
    "mass",
    "matter",
    "metal",
    "molecule",
    "oxygen",
    "particle",
    "particulate",
    "ph",
    "polymer",
    "pressure",
    "react",
    "reaction",
    "solid",
    "solution",
    "temperature",
    "volatile",
}

IMAGE_REQUIRED_FIELDS = [
    "Style:",
    "Character:",
    "Scenario:",
    "One-line story action:",
    "Composition:",
    "Constraints:",
]

BAD_IMAGE_PHRASES = [
    "science lab",
    "microscope",
    "simple inspection",
    "simple holding",
    "product close-up",
    "repeated table-demo",
    "looking at",
    "staring",
    "holding the",
]

REQUIRED_IMAGE_CONSTRAINTS = [
    "no science lab",
    "no microscope",
    "no simple inspection",
    "no simple holding",
    "no repeated table-demo",
    "no readable poster text",
    "no watermark",
]


@dataclass
class Scene:
    number: int
    image: str
    dialogue: str


@dataclass
class Outline:
    number: int
    title: str
    object_name: str
    scenes: list[Scene] = field(default_factory=list)


@dataclass
class Finding:
    severity: str
    outline: int | None
    scene: int | None
    kind: str
    message: str
    text: str = ""


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def parse_outlines(markdown: str) -> list[Outline]:
    matches = list(OUTLINE_RE.finditer(markdown))
    outlines: list[Outline] = []

    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        block = markdown[start:end]
        outline = Outline(
            number=int(match.group("number")),
            title=match.group("title").strip(),
            object_name=match.group("object").strip(),
        )

        current_scene_number: int | None = None
        current_image: str | None = None

        for raw_line in block.splitlines():
            line = raw_line.strip()
            scene_match = SCENE_RE.match(line)
            if scene_match:
                current_scene_number = int(scene_match.group("scene"))
                current_image = scene_match.group("text").strip()
                continue

            dialogue_match = DIALOGUE_RE.match(line)
            if dialogue_match and current_scene_number is not None and current_image:
                outline.scenes.append(
                    Scene(
                        number=current_scene_number,
                        image=current_image,
                        dialogue=dialogue_match.group("text").strip(),
                    )
                )
                current_scene_number = None
                current_image = None

        outlines.append(outline)

    return outlines


def audit_outline(outline: Outline) -> list[Finding]:
    findings: list[Finding] = []

    if len(outline.scenes) != 3:
        findings.append(
            Finding(
                "error",
                outline.number,
                None,
                "structure",
                f"Expected 3 scenes, found {len(outline.scenes)}.",
            )
        )

    image_norms = [normalize(scene.image) for scene in outline.scenes]
    dialogue_norms = [normalize(scene.dialogue) for scene in outline.scenes]

    for scene in outline.scenes:
        findings.extend(audit_image(outline, scene))
        findings.extend(audit_dialogue(outline, scene))

    if len(set(image_norms)) != len(image_norms):
        findings.append(
            Finding(
                "error",
                outline.number,
                None,
                "image-variety",
                "Two or more image descriptions are identical after normalization.",
            )
        )

    if len(set(dialogue_norms)) != len(dialogue_norms):
        findings.append(
            Finding(
                "error",
                outline.number,
                None,
                "dialogue-variety",
                "Two or more dialogue lines are identical after normalization.",
            )
        )

    scenario_words = []
    for scene in outline.scenes:
        scenario = extract_field(scene.image, "Scenario:", "One-line story action:")
        scenario_words.append(set(normalize(scenario).split()))

    for left in range(len(scenario_words)):
        for right in range(left + 1, len(scenario_words)):
            overlap = jaccard(scenario_words[left], scenario_words[right])
            if overlap > 0.45:
                findings.append(
                    Finding(
                        "warning",
                        outline.number,
                        None,
                        "scenario-variety",
                        f"Scenes {left + 1} and {right + 1} may be too similar (scenario word overlap {overlap:.0%}).",
                    )
                )

    return findings


def audit_image(outline: Outline, scene: Scene) -> list[Finding]:
    findings: list[Finding] = []
    lowered = scene.image.lower()
    scene_setup = lowered.split("constraints:", 1)[0]
    constraints = lowered.split("constraints:", 1)[1] if "constraints:" in lowered else ""

    for field_name in IMAGE_REQUIRED_FIELDS:
        if field_name not in scene.image:
            findings.append(
                Finding(
                    "error",
                    outline.number,
                    scene.number,
                    "image-field",
                    f"Missing required image field: {field_name}",
                    scene.image,
                )
            )

    if outline.object_name not in scene.image:
        findings.append(
            Finding(
                "error",
                outline.number,
                scene.number,
                "image-object",
                f"Image description does not name the primary object exactly: {outline.object_name}",
                scene.image,
            )
        )

    for phrase in BAD_IMAGE_PHRASES:
        if contains_banned_scene_phrase(scene_setup, phrase):
            findings.append(
                Finding(
                    "error",
                    outline.number,
                    scene.number,
                    "image-banned-phrase",
                    f"Image setup contains banned phrase: {phrase}",
                    scene.image,
                )
            )

    for phrase in REQUIRED_IMAGE_CONSTRAINTS:
        if phrase not in constraints:
            findings.append(
                Finding(
                    "error",
                    outline.number,
                    scene.number,
                    "image-constraint",
                    f"Missing required image constraint: {phrase}",
                    scene.image,
                )
            )

    if "one-line story action:" in lowered:
        action = extract_field(scene.image, "One-line story action:", "Composition:")
        action_norm = normalize(action)
        if len(action_norm.split()) < 9:
            findings.append(
                Finding(
                    "warning",
                    outline.number,
                    scene.number,
                    "image-action",
                    "One-line story action may be too thin; it should show a concrete event.",
                    scene.image,
                )
            )

        if not has_specific_action_verb(action_norm):
            findings.append(
                Finding(
                    "error",
                    outline.number,
                    scene.number,
                    "image-action",
                    "One-line story action lacks a concrete visual verb.",
                    scene.image,
                )
            )

    return findings


def audit_dialogue(outline: Outline, scene: Scene) -> list[Finding]:
    findings: list[Finding] = []
    lowered = scene.dialogue.lower()
    words = normalize(scene.dialogue).split()

    if len(words) < 12:
        findings.append(
            Finding(
                "warning",
                outline.number,
                scene.number,
                "dialogue-length",
                "Dialogue is very short; it may not carry enough story plus concept.",
                scene.dialogue,
            )
        )

    if len(words) > 28:
        findings.append(
            Finding(
                "warning",
                outline.number,
                scene.number,
                "dialogue-length",
                "Dialogue is long; one punchy sentence is preferred.",
                scene.dialogue,
            )
        )

    for phrase in BAD_DIALOGUE_PHRASES:
        if phrase in lowered:
            findings.append(
                Finding(
                    "error",
                    outline.number,
                    scene.number,
                    "dialogue-banned-phrase",
                    f"Dialogue contains generic/fluffy banned phrase: {phrase}",
                    scene.dialogue,
                )
            )

    object_keywords = object_keyword_set(outline.object_name)
    if outline.object_name.lower() not in lowered and not any(keyword in lowered for keyword in object_keywords):
        findings.append(
            Finding(
                "error",
                outline.number,
                scene.number,
                "dialogue-scene-link",
                f"Dialogue does not reference the scene object or a clear object keyword. Expected one of: {', '.join(sorted(object_keywords))}",
                scene.dialogue,
            )
        )

    concept_keywords = concept_keyword_set(outline.title, outline.object_name)
    if not any(keyword in lowered for keyword in concept_keywords):
        findings.append(
            Finding(
                "error",
                outline.number,
                scene.number,
                "dialogue-concept-link",
                f"Dialogue does not use a concept-specific chemistry keyword. Expected one of: {', '.join(sorted(concept_keywords)[:8])}",
                scene.dialogue,
            )
        )

    if not any(term in lowered for term in SCIENCE_TERMS):
        findings.append(
            Finding(
                "error",
                outline.number,
                scene.number,
                "dialogue-science",
                "Dialogue has no concrete science term.",
                scene.dialogue,
            )
        )

    fluff_count = sum(1 for word in words if word in FLUFF_WORDS)
    if fluff_count >= 3:
        findings.append(
            Finding(
                "warning",
                outline.number,
                scene.number,
                "dialogue-fluff-density",
                f"Dialogue has {fluff_count} vague/fluff words.",
                scene.dialogue,
            )
        )

    return findings


def extract_field(text: str, start_marker: str, end_marker: str) -> str:
    start = text.find(start_marker)
    end = text.find(end_marker)
    if start == -1 or end == -1 or end <= start:
        return ""
    return text[start + len(start_marker) : end].strip()


def has_specific_action_verb(action_norm: str) -> bool:
    verbs = {
        "wipes",
        "clips",
        "presses",
        "slides",
        "swaps",
        "pours",
        "fans",
        "scrapes",
        "ties",
        "bundles",
        "snaps",
        "drops",
        "guides",
        "builds",
        "sets",
        "feeds",
        "heats",
        "launches",
        "measures",
        "stirs",
        "sprays",
        "replaces",
        "turns",
        "lights",
        "seals",
        "sorts",
        "balances",
        "labels",
    }
    return any(verb in action_norm.split() for verb in verbs)


def contains_banned_scene_phrase(scene_setup: str, phrase: str) -> bool:
    if phrase not in scene_setup:
        return False
    allowed_negations = (
        f"not a {phrase}",
        f"not an {phrase}",
        f"not {phrase}",
        f"no {phrase}",
    )
    return not any(negation in scene_setup for negation in allowed_negations)


def object_keyword_set(object_name: str) -> set[str]:
    stop = {"the", "a", "an", "single", "covered"}
    return {word for word in normalize(object_name).split() if len(word) > 2 and word not in stop}


def concept_keyword_set(title: str, object_name: str) -> set[str]:
    base = set(normalize(title).split()) | set(normalize(object_name).split())
    concept = normalize(title)

    concept_map = {
        "air pollution": {"pollution", "particulate", "soot", "particle", "exposure", "air"},
        "alcohol": {"alcohol", "ethanol", "volatile", "evaporate", "concentration", "dose"},
        "aldehyde": {"aldehyde", "vanillin", "molecule", "smell", "aroma", "structure"},
        "alkali metals": {"alkali", "lithium", "metal", "reactive", "charge", "ion"},
        "alkane": {"alkane", "wax", "carbon", "hydrogen", "burn", "melt"},
        "alkene": {"alkene", "double", "bond", "plastic", "polymer"},
        "alkyne": {"alkyne", "triple", "bond", "carbon", "flame"},
        "allotropes": {"allotrope", "carbon", "diamond", "graphite", "structure"},
        "amino acid": {"amino", "acid", "protein", "chain", "side"},
        "amphiphilic molecules": {"amphiphilic", "soap", "water", "oil", "molecule"},
    }

    for key, keywords in concept_map.items():
        if key in concept:
            base |= keywords

    return {word for word in base if len(word) > 2}


def jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def finding_to_dict(finding: Finding) -> dict[str, object]:
    return {
        "severity": finding.severity,
        "outline": finding.outline,
        "scene": finding.scene,
        "kind": finding.kind,
        "message": finding.message,
        "text": finding.text,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit 3-scene chemistry video outlines.")
    parser.add_argument(
        "outline",
        nargs="?",
        default="3-scene-chemistry-videos/50-three-scene-video-outlines.md",
        help="Path to the markdown outline file.",
    )
    parser.add_argument("--json", action="store_true", help="Emit findings as JSON.")
    parser.add_argument(
        "--max-findings",
        type=int,
        default=80,
        help="Maximum text findings to print in non-JSON mode.",
    )
    args = parser.parse_args()

    outline_path = Path(args.outline)
    markdown = outline_path.read_text(encoding="utf-8")
    outlines = parse_outlines(markdown)

    findings: list[Finding] = []
    if len(outlines) != 50:
        findings.append(
            Finding("error", None, None, "structure", f"Expected 50 outlines, found {len(outlines)}.")
        )

    for outline in outlines:
        findings.extend(audit_outline(outline))

    errors = [finding for finding in findings if finding.severity == "error"]
    warnings = [finding for finding in findings if finding.severity == "warning"]

    if args.json:
        print(
            json.dumps(
                {
                    "outline_count": len(outlines),
                    "error_count": len(errors),
                    "warning_count": len(warnings),
                    "findings": [finding_to_dict(finding) for finding in findings],
                },
                indent=2,
            )
        )
    else:
        print(f"Outlines: {len(outlines)}")
        print(f"Errors: {len(errors)}")
        print(f"Warnings: {len(warnings)}")
        print()

        for finding in findings[: args.max_findings]:
            where = ""
            if finding.outline is not None:
                where += f"outline {finding.outline}"
            if finding.scene is not None:
                where += f", scene {finding.scene}"
            if where:
                where = f" ({where})"
            print(f"[{finding.severity.upper()}] {finding.kind}{where}: {finding.message}")
            if finding.text:
                print(f"  {finding.text}")

        if len(findings) > args.max_findings:
            print(f"... {len(findings) - args.max_findings} more findings omitted.")

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
