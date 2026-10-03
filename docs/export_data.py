# Export clemency_labeled data to JSON for GitHub Pages
# Run this in a Databricks notebook to generate docs/clemency_data.json
# Then commit to GitHub so the route finder uses real data instead of the fallback.

import json, os

rows = spark.sql("""
    SELECT latitude, longitude, severity_score, clemency_score,
           source_type, kmeans_clemency, detail
    FROM workspace.default.clemency_labeled
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
""").sample(0.3, seed=42).collect()

data = []
for r in rows:
    data.append([
        round(r["latitude"], 5),
        round(r["longitude"], 5),
        round(r["severity_score"], 3),
        round(r["clemency_score"], 3),
        r["source_type"],
        r["kmeans_clemency"],
        (r["detail"] or "")[:60]
    ])

out_path = "/Workspace/Users/ksyogueboule@gmail.com/nearme/docs/clemency_data.json"
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w") as f:
    json.dump(data, f, separators=(",", ":"))

print(f"Exported {len(data)} entries to docs/clemency_data.json ({os.path.getsize(out_path) / 1024:.0f} KB)")
