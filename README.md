# misc

## docs

- [Zernike PSF Viewer 仕様書](docs/zernike-psf-viewer/SPEC.md) — Zernike 係数を GUI から入力し、
  瞳面（波面）と PSF を表示する Windows 向けツールの仕様書。
  実装形態は**単一 HTML ファイル**（インストール・ランタイム不要）、
  Zernike の規約は [`torchmfbd/zern.py`](https://github.com/aasensio/torchmfbd/blob/main/src/torchmfbd/zern.py)
  に準拠（Noll インデックス / Noll 正規化 / 位相は rad）。
