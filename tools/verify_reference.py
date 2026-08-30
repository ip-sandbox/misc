#!/usr/bin/env python3
"""コミット済みの参照 fixture を、本物の torchmfbd/zern.py と突き合わせる。

SPEC.md 付録 C.2 の手順。tools/gen_fixtures.py は zern.py の式を純 Python に
「転記」したものなので、numpy が使える環境で本物と一致することを確認する。

    pip install numpy
    git clone --depth 1 https://github.com/aasensio/torchmfbd /path/to/torchmfbd
    python3 tools/verify_reference.py --zern /path/to/torchmfbd/src/torchmfbd/zern.py

注意:
  - zern.py は先頭で matplotlib を import するが描画は使わないので、
    ここではダミーモジュールを差し込んで回避する（matplotlib のインストール不要）。
  - torchmfbd パッケージとしては import しない（__init__ が torch を要求するため）。
    zern.py をファイルパスから直接読み込む。
  - ZernikeNaive.R_nm は mode='Standard' のとき fact((n+m)/2 - j) に float を渡すため
    Python 3.10 以降では TypeError になる。torchmfbd 本体と同じく 'Jacobi' を使う。
"""

import argparse
import importlib.util
import os
import sys
import types

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FIX_DIR = os.path.join(HERE, "..", "tests", "fixtures")

DEFAULT_ZERN_PATHS = [
    "/home/user/aasensio/torchmfbd/src/torchmfbd/zern.py",
    os.path.join(HERE, "..", "..", "torchmfbd", "src", "torchmfbd", "zern.py"),
]


def load_zern(path):
    """matplotlib をスタブしたうえで zern.py を単体モジュールとして読み込む。"""
    if "matplotlib" not in sys.modules:
        mpl = types.ModuleType("matplotlib")
        plt = types.ModuleType("matplotlib.pyplot")
        for name in ("figure", "plot", "imshow", "show", "subplots", "colorbar"):
            setattr(plt, name, lambda *a, **k: None)
        plt.cm = types.SimpleNamespace(jet=None, viridis=None)
        mpl.pyplot = plt
        sys.modules["matplotlib"] = mpl
        sys.modules["matplotlib.pyplot"] = plt

    spec = importlib.util.spec_from_file_location("torchmfbd_zern_ref", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_matrix(name):
    rows = []
    with open(os.path.join(FIX_DIR, name)) as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            rows.append([float(v) for v in s.split(",")])
    return np.array(rows)


def read_triples(name):
    out = []
    with open(os.path.join(FIX_DIR, name)) as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            out.append([int(v) for v in s.split(",")])
    return out


def make_grid(n_pix, q):
    """SPEC.md 規約 R-4 / deconvolution.py precalculate_zernike と同一。"""
    x = np.linspace(-1, 1, n_pix)
    xx, yy = np.meshgrid(x, x)
    rho = q * np.sqrt(xx ** 2 + yy ** 2)
    theta = np.arctan2(yy, xx)
    mask = rho <= 1.0
    return rho, theta, mask


def compare(label, expected, actual, tol_norm_abs, tol_rel_sig, results):
    diff = np.abs(expected - actual)
    peak = np.max(np.abs(expected))
    norm_abs = float(np.max(diff) / peak) if peak > 0 else float(np.max(diff))
    sig = np.abs(expected) > 1e-6 * peak
    rel_sig = float(np.max(diff[sig] / np.abs(expected)[sig])) if np.any(sig) else 0.0
    ok = norm_abs < tol_norm_abs and rel_sig < tol_rel_sig
    results.append(ok)
    print("  %-28s normAbs=%.3e  relSig=%.3e  %s" % (label, norm_abs, rel_sig, "OK" if ok else "NG"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zern", default=None, help="torchmfbd/src/torchmfbd/zern.py のパス")
    args = ap.parse_args()

    path = args.zern
    if path is None:
        for p in DEFAULT_ZERN_PATHS:
            if os.path.exists(p):
                path = p
                break
    if not path or not os.path.exists(path):
        print("zern.py が見つかりません。--zern <path> で指定してください。", file=sys.stderr)
        return 2

    zern = load_zern(path)
    print("参照実装: %s" % os.path.abspath(path))
    print("numpy %s / Python %s\n" % (np.__version__, sys.version.split()[0]))

    results = []

    # --- (0) mode='Standard' が Python 3.10+ で使えないことの確認（仕様書の注記の裏取り） ---
    z = zern.ZernikeNaive(mask=[])
    try:
        z.R_nm(4, 0, np.array([0.5]))
        print("  R_nm(mode='Standard') は動作した（Python < 3.10 相当の挙動）")
    except TypeError as e:
        print("  R_nm(mode='Standard') は TypeError: %s" % e)
        print("  -> 付録 C.3 のとおり mode='Jacobi' を使う\n")

    # --- (1) Noll インデックス 231 件 ---
    print("[1] Noll インデックス (zernIndex)")
    rows = read_triples("noll_index.csv")
    bad = [(j, n, m, zern.zernIndex(j)) for j, n, m in rows if list(zern.zernIndex(j)) != [n, m]]
    ok = not bad and len(rows) == 231
    results.append(ok)
    print("  %d 件中 不一致 %d 件  %s" % (len(rows), len(bad), "OK" if ok else "NG"))
    for b in bad[:5]:
        print("    j=%d fixture=(%d,%d) reference=%s" % b)

    # --- (2) 代表モードの基底マップ  N=32, q=1 ---
    print("\n[2] 基底マップ (Z_nm, normalize_noll=True, mode='Jacobi')  N=32 q=1")
    rho, theta, mask = make_grid(32, 1.0)
    for j in (1, 4, 8, 11, 22, 100, 231):
        n, m = zern.zernIndex(j)
        ref = z.Z_nm(n, m, rho, theta, True, "Jacobi") * mask
        exp = read_matrix("zmap_noll%03d.csv" % j)
        compare("Noll %3d (n=%2d, m=%3d)" % (j, n, m), exp, ref, 1e-12, 1e-10, results)

    # --- (3) 合成波面と PSF  N=64, q=4 ---
    print("\n[3] 合成波面と PSF  N=64 q=4  coeff={4:0.30, 11:0.60, 8:-0.12} [rad]")
    n_pix, q = 64, 4.0
    rho, theta, mask = make_grid(n_pix, q)
    coeff = {4: 0.30, 11: 0.60, 8: -0.12}
    wf = np.zeros((n_pix, n_pix))
    for j, c in coeff.items():
        n, m = zern.zernIndex(j)
        wf += c * z.Z_nm(n, m, rho, theta, True, "Jacobi") * mask
    compare("wavefront", read_matrix("wavefront.csv"), wf, 1e-12, 1e-10, results)

    pupil = mask * np.exp(1j * wf)
    psf = np.abs(np.fft.fft2(pupil)) ** 2
    psf /= psf.sum()
    compare("psf (fftshift 済)", read_matrix("psf.csv"), np.fft.fftshift(psf), 1e-12, 1e-10, results)

    print("\n%s: %d / %d 項目が一致" % (
        "成功" if all(results) else "失敗", sum(results), len(results)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
