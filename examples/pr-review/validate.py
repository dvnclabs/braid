"""Validate an ATXF file against the ATXF v0.1 JSON Schema, plus tree checks.

    pip install jsonschema
    curl -sLO https://raw.githubusercontent.com/leostera/atxf/main/schema/v0.1/atxf.schema.json
    python3 validate.py atxf.schema.json conversation.atxf.jsonl
"""
import json
import sys

from jsonschema import Draft202012Validator

schema_path, atxf_path = sys.argv[1], sys.argv[2]
validator = Draft202012Validator(json.load(open(schema_path)))

ids, errors = set(), 0
lines = [line for line in open(atxf_path) if line.strip()]
for n, line in enumerate(lines, 1):
    rec = json.loads(line)
    for err in validator.iter_errors(rec):
        errors += 1
        print(f"line {n} ({rec.get('id')}): {err.message[:300]}")
    if n == 1:
        if rec.get("type") != "transcript":
            errors += 1
            print("line 1: the first record must be the transcript header")
        continue
    if rec["id"] in ids:
        errors += 1
        print(f"line {n}: duplicate id {rec['id']}")
    for ref in ("parentId", "fromId", "targetId"):
        if rec.get(ref) is not None and rec[ref] not in ids:
            errors += 1
            print(f"line {n}: {ref} {rec[ref]} is not defined on an earlier line")
    ids.add(rec["id"])

print(f"{len(lines)} records, {errors} errors")
sys.exit(1 if errors else 0)
