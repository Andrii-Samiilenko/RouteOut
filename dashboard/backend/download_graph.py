"""
One-time script to download the Barcelona pedestrian street network via OSMnx
and save it as a GraphML file that the backend loads at startup.

Run BEFORE the hackathon — takes 15-20 minutes and requires internet access.

Usage:
    cd routeout/backend
    python download_graph.py
"""
import sys
import time
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
OUTPUT = DATA_DIR / "barcelona_graph.graphml"


def main():
    try:
        import osmnx as ox
    except ImportError:
        print("ERROR: osmnx not installed. Run: pip install -r requirements.txt")
        sys.exit(1)

    if OUTPUT.exists():
        size_mb = OUTPUT.stat().st_size / 1_048_576
        print(f"Graph already exists at {OUTPUT} ({size_mb:.1f} MB)")
        ans = input("Re-download? [y/N] ").strip().lower()
        if ans != "y":
            print("Skipping download.")
            return

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print("Downloading Barcelona pedestrian network from OpenStreetMap…")
    print("This takes 15-20 minutes. Do not interrupt.")
    t0 = time.time()

    try:
        G = ox.graph_from_place("Barcelona, Spain", network_type="walk")
    except Exception as exc:
        print(f"Download failed: {exc}")
        print("Retry in a few minutes — OSM servers may be under load.")
        sys.exit(1)

    elapsed = time.time() - t0
    print(
        f"Downloaded in {elapsed:.0f}s — {len(G.nodes):,} nodes, {len(G.edges):,} edges"
    )
    print(f"Saving to {OUTPUT} …")
    ox.save_graphml(G, str(OUTPUT))
    size_mb = OUTPUT.stat().st_size / 1_048_576
    print(f"Saved ({size_mb:.1f} MB). The backend is now ready to start.")


if __name__ == "__main__":
    main()
