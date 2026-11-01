#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = PROJECT_ROOT / "pipeline" / "atlas" / "data" / "cldr_glottolog_joined.csv"
DEFAULT_GLOTTOLOG = PROJECT_ROOT / "datasets" / "glottolog-cldf" / "cldf" / "languages.csv"
OUTPUT = PROJECT_ROOT / "app" / "public" / "data" / "cldr-language-demographics.json"

REQUIRED_COLUMNS = {
    "territory_code",
    "territory_population",
    "territory_gdp_usd",
    "territory_literacy_percent",
    "population_percent",
    "speaker_count",
    "official_status",
    "iso639_3",
    "glottocode",
    "glottolog_name",
    "family_glottocode",
    "glottolog_macroarea",
    "latitude",
    "longitude",
}


def optional_number(value: str | None) -> float | None:
    if not value or not value.strip():
        return None
    try:
        number = float(value)
    except ValueError as error:
        raise ValueError(f"Expected a numeric CLDR value, got {value!r}") from error
    return number if math.isfinite(number) else None


def optional_integer(value: str | None) -> int | None:
    number = optional_number(value)
    return round(number) if number is not None else None


def read_glottolog(path: Path) -> dict[str, dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        rows = csv.DictReader(handle)
        return {
            (row["Glottocode"] or "").strip(): row
            for row in rows
            if (row["Glottocode"] or "").strip()
        }


def build(source: Path, glottolog_path: Path) -> int:
    glottolog_by_id = read_glottolog(glottolog_path)
    records: list[dict[str, Any]] = []
    levels: dict[str, int] = {}
    dialect_parent_count = 0
    names_mismatched = 0
    with source.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        missing_columns = REQUIRED_COLUMNS - set(reader.fieldnames or [])
        if missing_columns:
            raise ValueError(f"CLDR CSV is missing columns: {', '.join(sorted(missing_columns))}")

        for line_number, row in enumerate(reader, start=2):
            language_id = (row["glottocode"] or "").strip()
            territory_code = (row["territory_code"] or "").strip().upper()
            source_language_name = (row["glottolog_name"] or "").strip()
            glottolog = glottolog_by_id.get(language_id)
            if not language_id or not territory_code or not source_language_name:
                raise ValueError(f"Missing language or territory identifier on CSV line {line_number}")
            if glottolog is None:
                raise ValueError(
                    f"Glottocode {language_id!r} from CSV line {line_number} is not in "
                    f"the pinned Glottolog catalog {glottolog_path}"
                )

            language_name = (glottolog["Name"] or "").strip()
            if source_language_name != language_name:
                names_mismatched += 1
            level = (glottolog["Level"] or "").strip()
            levels[level] = levels.get(level, 0) + 1
            geometry_language_id = language_id if level == "language" else None
            if level == "dialect":
                parent_id = (glottolog["Language_ID"] or "").strip()
                parent = glottolog_by_id.get(parent_id)
                if parent and parent["Level"] == "language":
                    geometry_language_id = parent_id
                    dialect_parent_count += 1

            records.append(
                {
                    "territoryCode": territory_code,
                    "territoryPopulation": optional_integer(row["territory_population"]),
                    "territoryGdpUsd": optional_number(row["territory_gdp_usd"]),
                    "territoryLiteracyPercent": optional_number(
                        row["territory_literacy_percent"]
                    ),
                    "populationPercent": optional_number(row["population_percent"]),
                    "speakerCount": optional_integer(row["speaker_count"]),
                    "officialStatus": (row["official_status"] or "unspecified").strip(),
                    "iso6393": (row["iso639_3"] or "").strip() or None,
                    "languageRawCode": (row.get("language_raw_code") or "").strip() or None,
                    "languageId": language_id,
                    "languageName": language_name,
                    "glottologLevel": level,
                    "geometryLanguageId": geometry_language_id,
                    "familyId": (row["family_glottocode"] or "").strip() or None,
                    "macroareas": [
                        area.strip()
                        for area in (row["glottolog_macroarea"] or "").split(";")
                        if area.strip()
                    ],
                    "latitude": optional_number(row["latitude"]),
                    "longitude": optional_number(row["longitude"]),
                }
            )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(records, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Exported {len(records):,} CLDR language-territory records to {OUTPUT}")
    print(
        "Pinned Glottolog crosswalk: "
        + ", ".join(f"{count:,} {level} rows" for level, count in sorted(levels.items()))
        + f"; {dialect_parent_count:,} dialect rows use their Glottolog language parent for geometry."
    )
    if names_mismatched:
        print(
            f"Used the pinned Glottolog spelling for {names_mismatched:,} rows whose "
            "preprocessed name differed."
        )
    return len(records)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export the preprocessed CLDR join for the web app.")
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help=f"Joined CLDR CSV (default: {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--glottolog",
        type=Path,
        default=DEFAULT_GLOTTOLOG,
        help=f"Pinned Glottolog language catalog (default: {DEFAULT_GLOTTOLOG})",
    )
    args = parser.parse_args()
    if not args.source.is_file():
        raise FileNotFoundError(
            f"Could not find {args.source}. Run the CLDR preprocessing pipeline or pass --source."
        )
    if not args.glottolog.is_file():
        raise FileNotFoundError(
            f"Could not find {args.glottolog}. Download the pinned atlas sources first."
        )
    build(args.source, args.glottolog)


if __name__ == "__main__":
    main()
