# Frequency Warp — Web試聴版（共通Rust/WASM DSP）

**GitHub Pages公開URL（デプロイ成功後有効）**:
https://kinoko34077.github.io/frequency-warp-vst/

このページは **VST3アダプターと共通利用するRust音声処理コア** を
WebAssemblyにコンパイルし、ブラウザのWeb Workerから実行する研究版。
ブラウザはファイル読込、波形描画、原音／Wet再生、WAV保存を担当する。
以前のJavaScript製独立STFTプロセッサは削除済み。

## 使い方
1. Pagesを開き、WAV/MP3等の音声ファイルを選ぶ（アップロードは発生しない）。
2. Curvature、Invert、Fold/Blend、Wet、Qualityを設定。
3. 「音声を変換する」を押し、処理後に原音／変換音を聴き比べる。
4. 必要ならWAV保存。Wetだけは変換後もすぐ混合割合を変えられる。

**先頭最大120秒**を対象にする。長尺・高品質設定ではCPUとメモリ使用量が
増え、処理完了まで時間を要する。現行処理はWorker上の一括実行で、
中間の実進捗率は測れない。不要ならページ再読込で中止できる。
5分以上などのさらに長い音声やストリーミングは今後の課題。

## ローカル実行
Rustツールチェーン、wasm32-unknown-unknown、Pythonが必要。
\`\`\`sh
rustup target add wasm32-unknown-unknown
cargo build --manifest-path core/Cargo.toml --release --target wasm32-unknown-unknown
cp core/target/wasm32-unknown-unknown/release/frequency_warp_core.wasm web-demo/dsp_core.wasm
python3 -m http.server 8000
\`\`\`
http://localhost:8000/web-demo/ を開く。単体 \`standalone.html\` は
**旧JS独立版の提供を終了したためPagesへの案内**に変更した。

## 音質・処理境界
- 共通DSPは現時点で **R2.1のオフラインSTFT候補**。ノイズ・残響・交差音などの
  成分欠落、位相・音量変化、トランジェントの劣化が残る。完成VST3でも
  最終アルゴリズムでもない。
- 解析の暫定範囲は20Hz〜min(16000,サンプルレート×0.45)。帯域外を消す
  実装上の暫定挙動は製品要件の決定ではない。Reflect/Kill/Fadeも未実装。
- Qualityは処理予算の暫定3段階であり、高品質ほど常に聴感が良いという保証はない。
- AudioContext.decodeAudioDataによりブラウザの出力サンプルレートへ
  リサンプルされる場合がある。このデモは入力フォーマットの完全な
  ビット単位保存を保証しない。
- Web上の試聴とVST側の最終サウンドが一致するためには、今後の
  VST3アダプターも **同じRust DSP処理実装**へ接続する。

## テスト
\`\`\`sh
cargo test --manifest-path core/Cargo.toml
node --test web-demo/core-wasm.test.mjs
node --test web-demo/wasm-browser-smoke.test.mjs
\`\`\`
Node/WASMおよびChrome統合試験はコンパイル済み
\`web-demo/dsp_core.wasm\` を要求する。正式CIは
\`shared-core-tests.yml\`、公開ビルドは \`pages.yml\` に記録する。

設計正本: [#10](https://github.com/kinoko34077/frequency-warp-vst/issues/10) /
[共通DSP設計](../docs/SHARED_DSP_ARCHITECTURE.md)。
