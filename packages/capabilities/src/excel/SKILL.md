# Fill an Excel template

Use the supplied workbook as the template. Inspect its sheet names and cell locations with Python and `openpyxl`. Put the requested edits in a UTF-8 JSON file keyed by sheet name and cell address.

```json
{
  "Estimate": {
    "B5": { "value": 12 },
    "C5": { "value": "Materials" },
    "D5": { "formula": "=B5*2" }
  }
}
```

Run `python3 /opt/t45/excel/fill.py TEMPLATE CELLS.json OUTPUT.xlsx`. A value can be text, a number, a boolean, or null to clear a cell. Use a formula only when the workbook is meant to calculate it. Other cells keep their existing values and styles. Write to a new file, check the result, and share it using the step tools when available.

For a workbook that needs hyperlinks, formatting changes, or cached formula results, a Node script can import ExcelJS from `/opt/t45/excel/workbook.cjs`.
