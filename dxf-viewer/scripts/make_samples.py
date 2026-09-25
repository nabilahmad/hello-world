#!/usr/bin/env python3
"""Regenerate the sample drawings and parser test fixtures.

Development-time only: the viewer itself does not depend on Python.
Requires ezdxf (MIT licensed):  pip install ezdxf

    python3 scripts/make_samples.py

Writes:
  samples/plate-mm.dxf          R2010, millimetres; covers most entity types
  samples/bracket-r12.dxf       R12 (AC1009), POLYLINE/VERTEX, no units
  tests/fixtures/plate-bin.dxf  binary DXF copy of the plate
  tests/fixtures/cp1251.dxf     R2000 with $DWGCODEPAGE ANSI_1251 text
"""
import math
import pathlib

import ezdxf
from ezdxf import units
from ezdxf.enums import TextEntityAlignment

ROOT = pathlib.Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "samples"
FIXTURES = ROOT / "tests" / "fixtures"


def rounded_rect(w, h, r):
    """Closed LWPOLYLINE points (x, y, bulge), counter-clockwise from (r, 0)."""
    b = math.tan(math.radians(90) / 4)  # bulge of a 90 degree CCW arc
    return [
        (r, 0, 0), (w - r, 0, b),
        (w, r, 0), (w, h - r, b),
        (w - r, h, 0), (r, h, b),
        (0, h - r, 0), (0, r, b),
    ]


def make_plate():
    doc = ezdxf.new("R2010", setup=True)
    doc.units = units.MM
    doc.header["$MEASUREMENT"] = 1
    doc.header["$LUPREC"] = 2
    msp = doc.modelspace()

    doc.layers.add("OUTLINE", color=7)
    doc.layers.add("HOLES", color=1)
    doc.layers.add("CENTER", color=3, linetype="CENTER")
    doc.layers.add("FEATURES", color=5)
    doc.layers.add("DIMS", color=4)
    doc.layers.add("NOTES", color=2)
    doc.layers.add("HATCH", color=8)
    hidden = doc.layers.add("CONSTRUCTION", color=9)
    hidden.off()

    # 200 x 120 plate with 10 mm corner fillets: extents are exactly 200 x 120.
    msp.add_lwpolyline(rounded_rect(200, 120, 10), format="xyb", close=True,
                       dxfattribs={"layer": "OUTLINE"})

    # Mounting holes + centre bore.
    for x, y in [(20, 20), (180, 20), (20, 100), (180, 100)]:
        msp.add_circle((x, y), 4, dxfattribs={"layer": "HOLES"})
        msp.add_line((x - 7, y), (x + 7, y), dxfattribs={"layer": "CENTER"})
        msp.add_line((x, y - 7), (x, y + 7), dxfattribs={"layer": "CENTER"})
    msp.add_circle((100, 60), 25, dxfattribs={"layer": "HOLES"})

    # Obround slot: centres (140, 60) .. (160, 60), width 10.
    msp.add_lwpolyline([(140, 55, 0), (160, 55, 1), (160, 65, 0), (140, 65, 1)],
                       format="xyb", close=True, dxfattribs={"layer": "FEATURES"})

    # "C" cut-out: ARC 45..315 degrees closed with two lines.
    c, r = (55, 60), 12
    msp.add_arc(c, r, 45, 315, dxfattribs={"layer": "FEATURES"})
    p45 = (c[0] + r * math.cos(math.radians(45)), c[1] + r * math.sin(math.radians(45)))
    p315 = (c[0] + r * math.cos(math.radians(315)), c[1] + r * math.sin(math.radians(315)))
    msp.add_line(p45, (c[0] + 16, p45[1]), dxfattribs={"layer": "FEATURES"})
    msp.add_line(p315, (c[0] + 16, p315[1]), dxfattribs={"layer": "FEATURES"})

    # Mirrored arc: OCS extrusion (0, 0, -1). OCS centre (-70, 30) is WCS (70, 30),
    # and the 0..90 degree OCS arc becomes the upper-left quadrant in WCS.
    msp.add_arc((-70, 30), 8, 0, 90, dxfattribs={"layer": "FEATURES", "extrusion": (0, 0, -1)})

    # Ellipse and splines.
    msp.add_ellipse((100, 22), major_axis=(12, 0), ratio=0.5, dxfattribs={"layer": "FEATURES"})
    msp.add_open_spline([(125, 100), (130, 112), (140, 88), (150, 110), (156, 100)],
                        degree=3, dxfattribs={"layer": "FEATURES"})
    msp.add_spline(fit_points=[(30, 75), (36, 82), (44, 78), (50, 86)],
                   dxfattribs={"layer": "FEATURES"})

    # Blocks: BOSS on layer 0 with BYBLOCK colour, inserted plain, rotated/scaled, mirrored.
    boss = doc.blocks.new("BOSS", base_point=(0, 0))
    boss.add_circle((0, 0), 6, dxfattribs={"layer": "0", "color": 0})
    boss.add_circle((0, 0), 3, dxfattribs={"layer": "0", "color": 0})
    boss.add_lwpolyline([(6, 0), (10, 0), (10, 4)], dxfattribs={"layer": "0", "color": 0})
    boss.add_arc((0, 0), 8, 0, 60, dxfattribs={"layer": "0", "color": 0})
    msp.add_blockref("BOSS", (100, 100), dxfattribs={"layer": "FEATURES", "color": 6})
    msp.add_blockref("BOSS", (40, 100), dxfattribs={"layer": "FEATURES", "rotation": 30,
                                                     "xscale": 0.8, "yscale": 0.8})
    msp.add_blockref("BOSS", (40, 25), dxfattribs={"layer": "FEATURES", "xscale": -1})

    # MINSERT: 3 x 2 array of vent holes.
    vent = doc.blocks.new("VENT")
    vent.add_circle((0, 0), 1.5, dxfattribs={"layer": "0"})
    msp.add_blockref("VENT", (160, 85), dxfattribs={
        "layer": "HOLES", "column_count": 3, "row_count": 2,
        "column_spacing": 6, "row_spacing": 6})

    # Pocket with ANSI31 pattern hatch, plus a solid-filled marker triangle.
    pocket = [(120, 30), (150, 30), (150, 45), (120, 45)]
    msp.add_lwpolyline(pocket, close=True, dxfattribs={"layer": "FEATURES"})
    hatch = msp.add_hatch(color=256, dxfattribs={"layer": "HATCH"})
    hatch.set_pattern_fill("ANSI31", scale=0.5)
    hatch.paths.add_polyline_path(pocket, is_closed=True)
    solid = msp.add_hatch(color=2, dxfattribs={"layer": "NOTES"})
    solid.paths.add_polyline_path([(8, 108), (14, 108), (8, 114)], is_closed=True)

    # Annotation outside the part outline (excluded from "geometry" extents).
    msp.add_text("PLATE-01", height=5, dxfattribs={"layer": "NOTES"}).set_placement(
        (0, 126), align=TextEntityAlignment.BOTTOM_LEFT)
    msp.add_mtext("Material: 6061-T6\\PThickness: 5 mm",
                  dxfattribs={"layer": "NOTES", "char_height": 3.5, "insert": (120, 134)})
    dim = msp.add_linear_dim(base=(0, -22), p1=(0, 0), p2=(200, 0), dimstyle="EZDXF",
                             override={"dimtxt": 3.5, "dimasz": 3, "dimblk": "", "dimtsz": 0,
                                       "dimlfac": 1, "dimexo": 1.5, "dimexe": 2, "dimgap": 1},
                             dxfattribs={"layer": "DIMS"})
    dim.render()

    # Construction geometry on a layer that is OFF in the file.
    msp.add_line((-30, -30), (230, 150), dxfattribs={"layer": "CONSTRUCTION"})
    return doc


def make_bracket_r12():
    doc = ezdxf.new("R12")
    msp = doc.modelspace()
    doc.layers.add("PART", color=7)
    doc.layers.add("HOLES", color=1)
    b = math.tan(math.radians(90) / 4)
    # L-shaped bracket 4 x 3 with an inside fillet (R 0.5) as a 2D POLYLINE with bulges.
    pts = [(0, 0, 0), (4, 0, 0), (4, 1, 0), (1.5, 1, -b), (1, 1.5, 0), (1, 3, 0), (0, 3, 0)]
    msp.add_polyline2d([(x, y) for x, y, _ in pts], close=True, dxfattribs={"layer": "PART"})
    poly = msp.query("POLYLINE").first
    for v, (_, _, bulge) in zip(poly.vertices, pts):
        v.dxf.bulge = bulge
    msp.add_circle((3.25, 0.5), 0.2, dxfattribs={"layer": "HOLES"})
    msp.add_circle((0.5, 2.5), 0.2, dxfattribs={"layer": "HOLES"})
    msp.add_arc((0.5, 0.5), 0.3, 90, 270, dxfattribs={"layer": "PART"})
    msp.add_text("BRACKET", height=0.2, dxfattribs={"layer": "PART", "insert": (1.5, 2.5)})
    return doc


def make_cp1251():
    doc = ezdxf.new("R2000")
    doc.header["$DWGCODEPAGE"] = "ANSI_1251"
    doc.encoding = "cp1251"
    msp = doc.modelspace()
    msp.add_line((0, 0), (10, 0))
    msp.add_text("Привет", height=2, dxfattribs={"insert": (0, 2)})
    return doc


def main():
    SAMPLES.mkdir(exist_ok=True)
    FIXTURES.mkdir(parents=True, exist_ok=True)
    plate = make_plate()
    plate.saveas(SAMPLES / "plate-mm.dxf")
    plate.saveas(FIXTURES / "plate-bin.dxf", fmt="bin")
    make_bracket_r12().saveas(SAMPLES / "bracket-r12.dxf")
    make_cp1251().saveas(FIXTURES / "cp1251.dxf")
    for p in sorted(list(SAMPLES.glob("*.dxf")) + list(FIXTURES.glob("*.dxf"))):
        print(f"{p.relative_to(ROOT)}  {p.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
