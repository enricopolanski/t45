"""Fill named cells in an Excel template using a JSON sheet map."""

import argparse
import json
from pathlib import Path

from openpyxl import load_workbook


def fill_workbook(template, cell_map, output):
    with template.open("rb") as source:
        workbook = load_workbook(source)
    for name, cells in cell_map.items():
        worksheet = workbook[name]
        for address, edit in cells.items():
            cell = worksheet[address]
            if set(edit) == {"formula"}:
                formula = edit["formula"]
                if not isinstance(formula, str) or not formula.startswith("="):
                    raise ValueError(f"{name}!{address} requires an Excel formula")
                cell.value = formula
            elif set(edit) == {"value"}:
                value = edit["value"]
                cell.value = value
                if isinstance(value, str):
                    cell.data_type = "s"
            else:
                raise ValueError(f"{name}!{address} requires exactly one value or formula")
    workbook.save(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path)
    parser.add_argument("cells", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with args.cells.open(encoding="utf-8") as source:
        cell_map = json.load(source)
    fill_workbook(args.template, cell_map, args.output)


if __name__ == "__main__":
    main()
