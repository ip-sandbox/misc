#!/usr/bin/env python3
"""参照 fixture 生成スクリプト（純 Python / numpy 不要）

SPEC.md §5.1 の規約 R-1〜R-6 を、参照実装 torchmfbd/zern.py の該当コードから
転記したもの。生成した CSV は tests/fixtures/ にコミットし、UT-04 / UT-18 で
JavaScript 実装と突き合わせる。

    python3 tools/gen_fixtures.py

注意:
  - これは zern.py の「転記」であり、zern.py そのものの実行ではない。
    numpy が使える開発機では SPEC.md 付録 C.2 の手順で本物の torchmfbd から
    再生成し、本スクリプトの出力と一致することを確認すること。
  - zern.py の ZernikeNaive.R_nm は mode='Standard' のとき
    fact((n+m)/2 - j) に float を渡すため Python 3.10 以降では TypeError になる。
    本スクリプトは同じ式を整数除算で評価している（値は同一）。
"""

import math
import os

FIX_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures")

N_MAX = 20
J_MAX = (N_MAX + 1) * (N_MAX + 2) // 2  # 231


# --- zern.py: zernIndex(j) の転記 -------------------------------------------
def zern_index(j):
    n = int((-1.0 + math.sqrt(8 * (j - 1) + 1)) / 2.0)
    p = j - (n * (n + 1)) / 2.0
    k = n % 2
    m = int((p + k) / 2.0) * 2 - k
    if m != 0:
        m *= 1 if j % 2 == 0 else -1
    return n, m


# --- zern.py: ZernikeNaive.R_nm の転記（整数除算版） ------------------------
def radial(n, m, rho):
    n, m = abs(n), abs(m)
    if (n - m) % 2 != 0:
        return 0.0
    r = 0.0
    for s in range((n - m) // 2 + 1):
        num = (-1) ** s * math.factorial(n - s)
        den = math.factorial(s) * math.factorial((n + m) // 2 - s) * math.factorial((n - m) // 2 - s)
        r += (num / den) * rho ** (n - 2 * s)
    return r


# --- zern.py: ZernikeNaive.Z_nm(normalize_noll=True) の転記 -----------------
def zernike(n, m, rho, theta):
    r = radial(n, m, rho)
    if m == 0:
        if n == 0:
            return 1.0
        return math.sqrt(n + 1) * r
    if m > 0:
        return math.sqrt(2) * math.sqrt(n + 1) * r * math.cos(abs(m) * theta)
    return math.sqrt(2) * math.sqrt(n + 1) * r * math.sin(abs(m) * theta)


# --- deconvolution.py: precalculate_zernike のグリッド（R-4）の転記 ---------
def make_grid(n_pix, q):
    """x = linspace(-1, 1, n_pix)（端点を含む）、rho = q * sqrt(x^2 + y^2)"""
    xs = [-1.0 + 2.0 * i / (n_pix - 1) for i in range(n_pix)]
    rho = [[0.0] * n_pix for _ in range(n_pix)]
    theta = [[0.0] * n_pix for _ in range(n_pix)]
    mask = [[0.0] * n_pix for _ in range(n_pix)]
    for row in range(n_pix):
        y = xs[row]
        for col in range(n_pix):
            x = xs[col]
            rho[row][col] = q * math.sqrt(x * x + y * y)
            theta[row][col] = math.atan2(y, x)
            mask[row][col] = 1.0 if rho[row][col] <= 1.0 else 0.0
    return rho, theta, mask


def zernike_map(j, rho, theta, mask):
    n, m = zern_index(j)
    n_pix = len(rho)
    out = [[0.0] * n_pix for _ in range(n_pix)]
    for row in range(n_pix):
        for col in range(n_pix):
            if mask[row][col]:
                out[row][col] = zernike(n, m, rho[row][col], theta[row][col])
    return out


# --- 検証用の素朴な radix-2 FFT（fixture 生成専用） -------------------------
def fft1d(re, im):
    n = len(re)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            re[i], re[j] = re[j], re[i]
            im[i], im[j] = im[j], im[i]
    length = 2
    while length <= n:
        ang = -2.0 * math.pi / length
        wr, wi = math.cos(ang), math.sin(ang)
        for i in range(0, n, length):
            cr, ci = 1.0, 0.0
            for k in range(length // 2):
                a, b = i + k, i + k + length // 2
                tr = re[b] * cr - im[b] * ci
                ti = re[b] * ci + im[b] * cr
                re[b], im[b] = re[a] - tr, im[a] - ti
                re[a], im[a] = re[a] + tr, im[a] + ti
                cr, ci = cr * wr - ci * wi, cr * wi + ci * wr
        length <<= 1


def fft2d(re, im):
    n = len(re)
    for row in range(n):
        fft1d(re[row], im[row])
    for col in range(n):
        cr = [re[r][col] for r in range(n)]
        ci = [im[r][col] for r in range(n)]
        fft1d(cr, ci)
        for r in range(n):
            re[r][col], im[r][col] = cr[r], ci[r]


def fftshift(a):
    n = len(a)
    h = n // 2
    return [[a[(r + h) % n][(c + h) % n] for c in range(n)] for r in range(n)]


def write_matrix(path, mat, fmt="%.17g", header=None):
    with open(path, "w", newline="\n") as f:
        if header:
            f.write("# " + header + "\n")
        for row in mat:
            f.write(",".join(fmt % v for v in row) + "\n")
    print("wrote", os.path.relpath(path), "(%d x %d)" % (len(mat), len(mat[0])))


def main():
    os.makedirs(FIX_DIR, exist_ok=True)

    # (1) Noll インデックス表  j = 1..231
    path = os.path.join(FIX_DIR, "noll_index.csv")
    with open(path, "w", newline="\n") as f:
        f.write("# j,n,m  (torchmfbd/zern.py zernIndex)\n")
        for j in range(1, J_MAX + 1):
            n, m = zern_index(j)
            f.write("%d,%d,%d\n" % (j, n, m))
    print("wrote", os.path.relpath(path), "(%d rows)" % J_MAX)

    # (2) 代表モードの基底マップ  N=32, q=1
    n_pix, q = 32, 1.0
    rho, theta, mask = make_grid(n_pix, q)
    for j in (1, 4, 8, 11, 22, 100, 231):
        zmap = zernike_map(j, rho, theta, mask)
        n, m = zern_index(j)
        write_matrix(
            os.path.join(FIX_DIR, "zmap_noll%03d.csv" % j),
            zmap,
            header="noll=%d n=%d m=%d N=%d q=%g normalize_noll=True masked" % (j, n, m, n_pix, q),
        )

    # (3) 合成波面と PSF  N=64, q=4
    n_pix, q = 64, 4.0
    rho, theta, mask = make_grid(n_pix, q)
    coeff = {4: 0.30, 11: 0.60, 8: -0.12}  # Noll j -> 係数 [rad]
    wf = [[0.0] * n_pix for _ in range(n_pix)]
    for j, c in coeff.items():
        zmap = zernike_map(j, rho, theta, mask)
        for r in range(n_pix):
            for cidx in range(n_pix):
                wf[r][cidx] += c * zmap[r][cidx]
    write_matrix(
        os.path.join(FIX_DIR, "wavefront.csv"),
        wf,
        header="wavefront unit=rad N=%d q=%g coeff_noll=%s" % (n_pix, q, coeff),
    )

    re = [[mask[r][c] * math.cos(wf[r][c]) for c in range(n_pix)] for r in range(n_pix)]
    im = [[mask[r][c] * math.sin(wf[r][c]) for c in range(n_pix)] for r in range(n_pix)]
    fft2d(re, im)
    psf = [[re[r][c] ** 2 + im[r][c] ** 2 for c in range(n_pix)] for r in range(n_pix)]
    total = sum(sum(row) for row in psf)
    psf = [[v / total for v in row] for row in psf]
    write_matrix(
        os.path.join(FIX_DIR, "psf.csv"),
        fftshift(psf),
        header="psf normalization=sum fftshift=True N=%d q=%g coeff_noll=%s" % (n_pix, q, coeff),
    )


if __name__ == "__main__":
    main()
