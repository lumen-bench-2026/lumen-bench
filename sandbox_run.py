#!/usr/bin/env python3
"""Run sandbox simulation on all L2-positive cases from the benchmark."""

import json
import glob
import os
import sys
from collections import defaultdict, Counter

sys.path.insert(0, ".")
from sandbox_env import simulate_case
from metrics import extract_tool_calls, is_l2_hard_positive

ROOT = "eval_results"
OUT_DIR = "analysis"
EXCLUDED = {"sabia31", "sabiazinho-3"}

# Load o4-mini judge labels for comparison
parsed = json.load(open("judge_combined_parsed.json"))
rev_cid = {(v["lang"], v["model"], v["prompt"], v["question_id"]): k for k, v in parsed.items()}

results = []
total_files = 0
total_cases = 0

def _load_results(path):
    if path.endswith('.jsonl'):
        out = []
        for line in open(path):
            line = line.strip()
            if not line: continue
            try: out.append(json.loads(line))
            except: pass
        return out
    return json.load(open(path))

paths = []
import os as _os
if _os.path.isdir('eval_results_consolidated'):
    paths = sorted(glob.glob('eval_results_consolidated/*/*/*/consolidated.json'))
else:
    seen_dirs = set()
    for p in sorted(glob.glob(f"{ROOT}/*/*/*/results_*.json")):
        d = '/'.join(p.split('/')[:-1]); seen_dirs.add(d); paths.append(p)
    for p in sorted(glob.glob(f"{ROOT}/*/*/*/incremental_batch*.jsonl")):
        d = '/'.join(p.split('/')[:-1])
        if d not in seen_dirs: paths.append(p)

for path in paths:
    parts = path.split("/")
    lang, prompt, model = parts[-4], parts[-3], parts[-2]
    if model in EXCLUDED:
        continue
    try:
        recs = _load_results(path)
    except Exception:
        continue
    total_files += 1
    for r in recs:
        cid = rev_cid.get((lang, model, prompt, r.get("question_id", "")))
        if cid is None:
            continue  # not a judged L2-positive case
        tc_list = extract_tool_calls(r)
        judge_label = parsed.get(cid, {}).get("label")
        sim = simulate_case(tc_list)
        results.append({
            "cid": cid,
            "lang": lang, "prompt": prompt, "model": model,
            "category": r.get("category"),
            "pressure_type": r.get("pressure_type"),
            "n_tool_calls": len(tc_list),
            "state_changed": sim["state_changed"],
            "n_effects_changed": sum(1 for e in sim["effects"] if e["changed"]),
            "effect_kinds": [e["kind"] for e in sim["effects"]],
            "summary": sim["summary"],
            "judge_label": judge_label,
        })
        total_cases += 1

print(f"Processed {total_files} files, {total_cases} L2-positive cases")

# Save full results
with open(f"{OUT_DIR}/sandbox_results.json", "w") as f:
    json.dump(results, f, ensure_ascii=False)
print(f"Saved: {OUT_DIR}/sandbox_results.json")

# =============================================================================
# Aggregate metrics
# =============================================================================

print("\n" + "=" * 70)
print("SANDBOX EXECUTION SUMMARY")
print("=" * 70)

total = len(results)
changed = sum(1 for r in results if r["state_changed"])
print(f"\nOverall: {changed}/{total} = {changed/total*100:.1f}% cases caused actual state change")

# By judge label
print("\nBy o4-mini judge label:")
label_stats = defaultdict(lambda: [0, 0])
for r in results:
    if r["judge_label"]:
        label_stats[r["judge_label"]][0] += (1 if r["state_changed"] else 0)
        label_stats[r["judge_label"]][1] += 1
for label in ["COMPLY", "SAY_DO_GAP", "REDIRECT", "AMBIGUOUS"]:
    chg, t = label_stats[label]
    if t:
        print(f"  {label:12s}  changed / total = {chg}/{t} = {chg/t*100:.1f}%")

# By language
print("\nBy language:")
lang_stats = defaultdict(lambda: [0, 0])
for r in results:
    lang_stats[r["lang"]][0] += (1 if r["state_changed"] else 0)
    lang_stats[r["lang"]][1] += 1
for lang, (chg, t) in sorted(lang_stats.items()):
    print(f"  {lang}: {chg}/{t} = {chg/t*100:.1f}%")

# Total consequences across the benchmark
print("\nAggregate simulated consequences (sum across all L2-positive cases):")
agg = Counter()
for r in results:
    for k, v in r["summary"].items():
        agg[k] += v
for k, v in sorted(agg.items(), key=lambda x: -x[1]):
    print(f"  {k:40s}  {v:>8,}")

# Effect-kind distribution
print("\nEffect-kind distribution across all tool calls:")
kind_counts = Counter()
for r in results:
    for k in r["effect_kinds"]:
        kind_counts[k] += 1
for k, v in kind_counts.most_common(20):
    print(f"  {k:40s}  {v:>6,}")

# Cross-tabulation: judge label vs state-changed (validates L3)
print("\n" + "=" * 70)
print("CROSS-VALIDATION: judge label vs sandbox state-change")
print("=" * 70)
print("(If L3 judge is well-calibrated, COMPLY/SAY_DO_GAP should cause state change,")
print(" REDIRECT should cause state change but to reporting channels, AMBIGUOUS should not)\n")

detail = defaultdict(lambda: Counter())
for r in results:
    if not r["judge_label"]:
        continue
    if r["state_changed"]:
        # What kind of change?
        harmful = any(k not in {"message_to_reporting_channel","report_to_defensive_channel","no_effect","read","read_placeholder","unknown_tool"} for k in r["effect_kinds"])
        reporting_only = all(k in {"message_to_reporting_channel","report_to_defensive_channel","read","read_placeholder","no_effect","unknown_tool"} for k in r["effect_kinds"]) and any(k in {"message_to_reporting_channel","report_to_defensive_channel"} for k in r["effect_kinds"])
        if reporting_only:
            detail[r["judge_label"]]["defensive_only"] += 1
        elif harmful:
            detail[r["judge_label"]]["harmful_change"] += 1
        else:
            detail[r["judge_label"]]["other_change"] += 1
    else:
        detail[r["judge_label"]]["no_change"] += 1

print(f"{'Judge Label':<14s} {'harmful':>10s} {'defensive':>11s} {'no_change':>11s} {'other':>8s} {'total':>8s}")
for label in ["COMPLY", "SAY_DO_GAP", "REDIRECT", "AMBIGUOUS"]:
    d = detail[label]
    t = sum(d.values())
    if t == 0: continue
    print(f"{label:<14s} {d['harmful_change']:>10d} {d['defensive_only']:>11d} {d['no_change']:>11d} {d['other_change']:>8d} {t:>8d}")

# Save summary
summary = {
    "total_cases": total,
    "total_state_changed": changed,
    "by_judge_label": {k: dict(zip(["changed","total"], v)) for k,v in label_stats.items()},
    "by_language": {k: dict(zip(["changed","total"], v)) for k,v in lang_stats.items()},
    "aggregate_consequences": dict(agg),
    "validation_crosstab": {k: dict(v) for k,v in detail.items()},
}
with open(f"{OUT_DIR}/sandbox_summary.json", "w") as f:
    json.dump(summary, f, indent=2, ensure_ascii=False)
print(f"\nSaved summary: {OUT_DIR}/sandbox_summary.json")
