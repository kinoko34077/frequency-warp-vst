# Frequency Warp — モジュール交換式VST3固定シェル仕様 v0.1

> **2026-10-15 正本追補 — 再ビルド最小化／交換式UI:** ユーザーの追加確定要件により、固定VST3シェルは演算だけでなく、HTML/CSS/JSの画面・操作部品・単位表示・パラメータ定義と接続対応も可能な範囲で交換可能にする。新しい共通仕様は [VST3_RELOADABLE_UI_RUNTIME.md](VST3_RELOADABLE_UI_RUNTIME.md) を参照。既存Webサイトを直接再利用し、WindowsではWebView2（実験的・明示opt-in）で表示する。固定128 ParamID・ClassID、既存DAW保存意味、非RT WASM実行、旧エンジン互換は維持する。現行UI-1/2/3 PR #146/#147/#148はソース・CI段階で統合済みだが、UIパッケージ正式形式、汎用64枠セマンティクス、実機FL Studio検証は未完了。以下の「UI方式未定」「ネイティブ未実装」等は**2026-10-14当時の基礎設計履歴**であり、現行実装状態を表すものではない。


**状態**: 2026-10-14 設計正本・実装開始用ベースライン。VST3バイナリは未実装。既存音声エンジンを製品音質として受入済みという意味ではない。
**Owning**: [#81](https://github.com/kinoko34077/frequency-warp-vst/issues/81)、監査 [#80](https://github.com/kinoko34077/frequency-warp-vst/issues/80)。初期要件 [#3](https://github.com/kinoko34077/frequency-warp-vst/issues/3)、音声評価 [#5](https://github.com/kinoko34077/frequency-warp-vst/issues/5)、個別不具合 [#48](https://github.com/kinoko34077/frequency-warp-vst/issues/48)、パラメータ [#79](https://github.com/kinoko34077/frequency-warp-vst/issues/79) と責務分離。現在の主要参照 main `32b3cde5b850f8c575e49c1a2846b4a9c2402cba`。

## 1. 目的・決定事項

VST3を一度ホスト側へインストールした後は、**処理プログラムを記録した単一ファイル**を読ませるだけでエフェクトの演算を更新する。プラグイン本体の再ビルド・DAWのプラグイン再スキャンを通常の演算変更では要求しない。DAWの自動化・保存・音声バス・GUI・ファイルロードは固定されたVST3「ガワ」が所有する。

### 固定した構成

```text
DAW (FL Studio / validation host)
  └─ Frequency Warp.vst3 [OS/CPU毎に一度だけビルド・インストール]
       ├─ VST3 IComponent + IAudioProcessor        ← 音声I/O、PDC、Host automation
       ├─ VST3 IEditController + editor            ← UI、単位表示、🔗、D&D／Browse
       ├─ Parameter Registry + Preset/Project State ← 安定ID、復元、対応表
       ├─ Module Manager [non-RT worker]           ← 検証、読込、コンパイル、試聴試験
       ├─ Real-Time Switcher [audio thread]        ← 構築済engine交換、クロスフェード
       └─ Sandboxed WASM runtime                   ← ファイルで交換する実DSP
            └─ user-selected *.fwengine
                 ├─ manifest.json
                 └─ engine.wasm  (shared Rust core由来にできる)
```

**通常時の交換**: `*.fwengine` のみ差替え。既存の `Frequency Warp.vst3` バンドル自体を変更しない。**例外的に本体再ビルドを要す**: ホストVST3インターフェース／固定ParamID、対応モジュールABIの非互換改定、ランタイム更新・セキュリティ修正・新しいOS/CPUバイナリ、必要な恒常的ホスト能力追加。プラグイン実行ファイルを書き換える「自己更新」は行わない。

**WASM採用理由**: OS別のDLL/dylibをそのままプラグインプロセスへロードする設計は任意ネイティブコードの実行と同義であり、安全な交換境界にならない。WASMならメモリ・import・I/Oを制限し、処理側をホストOSから分離できる。**それでもCPU暴走・クラッシュ・音切れは防げる保証がない**ため、事前検証と実音声試験を必要とする。WASM実行速度／JIT権限と署名制約は実測前に「十分速い」と断定しない。

## 2. 対象環境と最初の製品形態

- **初期対象**: Windows x64 VST3 audio effect、FL Studio を主要実ホストとし、Steinberg Validator と別系統のDAW（例 Reaper）でも検証。OS標準のファイル選択・ドラッグ＆ドロップ。VST3 SDKを使用。
- **後続対象**: macOS（Intel/Apple Silicon、署名・公証・Hardened Runtimeとの整合）、必要に応じLinux。単一シェルバイナリで全OS共通という意味ではない。
- **バス**: 入力1本・出力1本、monoまたはstereo。対応しないチャンネル数・バス配置は明示的に拒否し、隠れた自動モノラル化をしない。MIDI音源ではなく**オーディオエフェクト**。サイドチェーン／MIDI入力はv1非対応。
- **サンプル**: host `f32` 基準、`f64` は事前確保の変換バッファを介して正しく変換する。両方をサポートする宣言は動作試験が通ってから。mono/stereo共通、ホストが渡す可変ブロック長／ゼロフレーム（パラメータフラッシュ）を扱う。
- **処理対象**: 外部WAVファイルを渡す必要はない。DAWから供給される**連続的な音声ストリーム**を受けて、変換音を返す。GUIへ落とすファイルは演算モジュールであって、録音音源のドロップとは区別する。
- **UI**: メインコントロールは既存Web版を意味・単位の参照基準とするが、Web AudioWorklet自体をVST3プロセッサへ転用しない。ホストGUIと音声は各々の責務。Webの一般フォームではなくVST3のGUI実装とする。移植技術選択（VSTGUI/native/WebView）は試作ベンチマークで決める。

## 3. 単一モジュールファイル `*.fwengine` (v1)

拡張子は `.fwengine`。実体は**サイズ上限を持つZIPコンテナ**。最低限 `manifest.json` と `engine.wasm`。追加の任意要素は `assets/` など明示したものに限定。不可視の任意DLL、シェルスクリプト、ファイルシステム・ネットワーク要求を拒否する。開発者モードに限り `.wasm` を直接読込可能にしてもよいが、ユーザー向け契約は `.fwengine` 一本に統一する。

例（正式JSONスキーマと整合を要す；例示値は製品IDではない）:

```json
{
  "format": "frequency-warp-engine",
  "format_version": 1,
  "engine_id": "org.example.spectral-v1",
  "engine_version": "0.1.0",
  "abi_major": 1,
  "abi_minor": 0,
  "entry": "engine.wasm",
  "sha256": "<64 lowercase hex digits of engine.wasm>",
  "max_memory_bytes": 67108864,
  "max_frames": 2048,
  "supported_channels": [1, 2],
  "nominal_latency_frames": 2047,
  "parameter_schema": "host-slots-v1"
}
```

`engine_id` とversion、content SHA-256はプロジェクト復元・互換性判定に使用。**ハッシュは改ざんを防ぐ署名ではない**。ユーザーが外部で入手した未署名モジュールをロードするときは、出所が未検証であることを明示する。必要なら将来の署名済パッケージを設ける。展開時のパストラバーサル・シンボリックリンク・ZIP爆弾・多重パス・圧縮後サイズ・重複エントリ・JSON深さ・文字列長を拒否し、モジュール上限／展開後上限を実装値として固定して検証する。ロード先のディレクトリ内から実行バイナリを探索・起動しない。

正式な機械可読制約は [schemas/fwengine-manifest-v1.schema.json](../schemas/fwengine-manifest-v1.schema.json) に置く。実装側はJSON Schema相当の全制約（必須キー、追加キー拒否、値域、拡張子とentry、展開サイズ）を実際に検証する。ドキュメント内のハッシュ表示 `<...>` は値の説明に過ぎず有効なmanifestではない。

### ABI versioning

- `abi_major=1` 以外は**読込拒否**。minorの追加は既存v1機能が同じ意味で動作するときのみ許可。
- WASMは32bit linear memoryの境界内ポインタ／offsetでやり取りする。構造体のレイアウト、little-endian、alignment、enum値、エラーコード、パラメータ正規化と物理値、チャンネル形式はv1で固定する。
- プラグインの識別子とHost ParamIDはモジュールが任意に生成・変更できない。エンジンは許可されたslotへローカルパラメータをbindingする。
- 既存のRust `warp_stream_*` C ABIは**v1 WASMモジュールAPIそのものではない**。変換用の極小 `fw_engine_adapter` を作り、元のRustエンジンを呼び出す。既存Web版に別の独自DSP実装を作らない。

## 4. v1 engine-call interface

```text
module exports:
  fw_abi_major() -> i32
  fw_create(sample_rate_f64, channels_u32, max_block_u32) -> handle_u32
  fw_get_latency_frames(handle_u32) -> u32
  fw_process(handle_u32, input_offset_u32, output_offset_u32,
             frames_u32, event_offset_u32, event_count_u32) -> status_i32
  fw_reset(handle_u32) -> status_i32
  fw_destroy(handle_u32) -> void

module memory:
  linear memory export + fixed input/output/event data layouts

parameter event v1:
  { host_param_id_u32, sample_offset_u32, canonical_value_f64 }
```

`fw_create`・`fw_destroy`・モジュールのロード／コンパイル／メモリ拡張／サンプルレート変更・品質変更のrebuildは**非audio callback**で行う。`fw_process` は用意済み入力・出力・parameter-eventメモリだけを使用し、alloc/free、ロック、ファイルI/O、ネットワーク、UI通知、非上限反復処理を行わない。イベントはoffset昇順、同時刻はhost sequence順。処理はホストの最大ブロック長より小さい呼出しへ分割できる。過剰イベントは事前確保キューを使って区間ごとに分割し、オートメーションを無言で捨てない。処理のバッファ形式は**非重複 planar f32**と固定し、in-placeが可能なDAWの入力と出力が同一の場合はホスト側に事前確保した別領域へコピーする。Rustの `warp_stream_process` に同一ポインタを渡さない（raw mutable/immutable sliceの重なりを回避）。

OS/hostからの変更はVST3 `IParamValueQueue` を受取りサンプルオフセットを保持。プラグイン画面側の操作はUIスレッドから `beginEdit/performEdit/endEdit` でホストを介して更新する。`process` 呼出し時、音声バッファなしのパラメータフラッシュも処理可能。独立したGUIレートでメータ表示し、process内でcontrollerに通知しない。VST3本体が処理・編集controllerを所有する（VST3仕様の分離）。

### S1 implementation note — v1 WASM memory layout (before native plugin release)

Host needs safe pointers into the module's *exported* linear memory, not host-native pointers or guessed offsets. v1 additionally requires these **pure metadata getters** after `fw_create`:

```text
fw_input_offset()  -> u32
fw_output_offset() -> u32
fw_event_offset()  -> u32
fw_event_capacity() -> u32
fw_event_stride()   -> u32  // must equal 16
```

Input/output samples are separate non-overlapping planar `f32` arrays containing `channels * frames` samples, with each plane's stride equal to the **actual** frame count of that call. Offsets refer to WASM linear-memory byte offsets; the host checks alignment, bounds and non-overlap **on every module preparation** and after any detected memory growth. Events use `repr(C)` 16 bytes, little endian: uint32 hostParamID at byte 0, uint32 sampleOffset at byte 4, float64 canonicalValue at byte 8. Events must be sorted by sample offset. The entire capacity must be preallocated before calling audio processing. Host checks `event_count <= capacity`, manifest maxFrames/channel/memory limit, output finite PCM. This amendment completes the missing interoperation data path, **without changing the v1 major**, since no VST3 module binary was previously published.

`frames==0` is a parameter-flush invocation with no audio read/write; any events at sampleOffset=0 apply to persistent engine state. Engine creation/reset/destruction, code validation and allocation are off the audio thread. A broken module must not silently become the active engine. A test-module may implement only host generic parameter slot 64 for Gain; future production modules must use the fixed registry with stable semantic bindings.

**S1 scope and evidence**: `fwengine-demo` is intentionally only a tiny separately compilable Identity/Gain engine, not a replacement for the real `core/src/stream.rs` DSP. `fwengine-package` is a reusable **native Rust archive preflight loader** (ZIP sizes/entries/identity/hash/manifest). `scripts/test_fwengine_runtime.mjs` acts as a **test-only WASM host**, validates zero imported functions and actual PCM when only the single `.fwengine` file changes. A future **native VST3 runtime** must also enforce WASM imports, memory/fuel budgets, thread affinity, executable lifetime and runtime trap handling; archive preflight alone does not make code safe. No VST3 host or drag/drop UI exists until S2/S3.

## 5. Host ParamID / 単位 / オートメーション

プラグインID（Processor/Controller Class IDs）は**初回公開時に一度生成し以後変更しない**。ホストへ公開するParamIDも変えない。VST3ではモジュール交換のたびにホストから見えるパラメータ数やIDを自由に変更できない。

v1は**固定128スロット**：
- `0..63`: シェル基幹＋周波数変換の安定ID。**正式な個別ParamID表は [vst3/PARAMETER_AUTOMATION.md](../vst3/PARAMETER_AUTOMATION.md) と [vst3/src/parameter_registry.h](../vst3/src/parameter_registry.h) に固定**（0..33割当済み、34..63予約）。旧定義と互換なしの意味変更は禁止（Wet、Bypass、L/H、Invert、Curvature、Shift、Pivot、Slope、反射・Ring・Crusher・品質等）。
- `64..127`: 汎用エンジン用64パラメータ枠。使用数／ラベル／単位／範囲／既定値はmanifestから検証して、空き枠に明示binding。**同じホストslotに別の意味を自動で割り当てない**。旧DAWオートメーションが新しい別の演算へ勝手に作用することを避ける。エンジン切替で無関係になったslotはinactive / neutralとし、プロジェクトに保存したslot→semantic-id対応を保持。
- プラグイン固有の高密度パラメータを追加する必要がある場合は、まず上記slotの上限と運用を再検討。新たなHost ParamIDを大量に自動生成して再スキャンさせる方式はv1では使わない。
- 実際のスロット名前の再読込はホストの許す `restartComponent(kParamTitlesChanged)` 等をUI側から実行。変更できるのはタイトル等であり、IDと数そのものではない。
- 内部正本値は `docs/PARAMETER_BINDING_SPEC.md` に従い、表示％／Hz／音名＋セント／倍率などは**次元と基準点に互換な場合だけ**許可。UI表示単位の切替でDSP正本数値やHost automationの意味は変えない。
- `🔗 H ↔ Pivot`、Ring carrier Fold link等は明示ON時のみ導出。手入力、Host automation、連動の競合順とsample-offset policyは統合前にテストで固定。MIDI/DAW再生位置/tempo由来の追加演算はv1では持ち込まない。

## 6. レイテンシ・切替・再生継続

v1 **固定PDC枠**は最大4095 samples（現行Rust FFT N=4096のlookahead）。この範囲に収まるモジュールだけをhot-swap対象とし、足りない分はシェルが遅延を補う。これによりモジュール差替えのたびにホストへPDC変更を通知せずに済む。4095は製品レイテンシとして小さくない（48kHzで約85.3ms）ため、製品品質評価で高過ぎる場合は固定枠方針自体をv2で見直す。**PDCより長いモジュールはロード前に拒否**。実際の新規moduleの `fw_get_latency_frames` はmanifest値と一致する必要がある。DAWの補償を伴わない間違った遅延報告をしない。

切替状態:
```text
ACTIVE(old)
  -> SELECTED(filename)        [UI; or OS drag/drop]
  -> VALIDATING                [worker; file + hash + manifest + WASM imports]
  -> PREPARING                 [worker; compile, instantiate, create, initialize, sanity PCM]
  -> READY(new)                [old remains processing]
  -> SWITCHING                 [RT: block-boundary atomic handoff; equal PDC aligned,
                                10–30ms bounded crossfade IF both budgets permit]
  -> ACTIVE(new)               [old retired off RT thread]
Fail at any stage: old stays active, explicit error; old state untouched.
```

**演奏停止は必須にしない**ことを目標とするが、実際のCPU負荷やlatency safety gate不合格時は「停止して切替」へフォールバックする。切替中に旧新2つのエンジンを同時に動かすとCPUが増えるため、double-engine負荷試験を必須とする。新エンジンの実行時fault/trap、破損出力、CPU超過はホストを落とさず、latency-aligned Dryまたは安全なMuteへ移行しUIへ明示。既知の最後の正常モジュールに戻せる。**WASMの悪意ある無限ループは通常の時間計測だけで確実には停止できない**ため、実行予算の実装（ランタイムのfuel等）と隔離方式の受入が必須。クラッシュ耐性は実装／故障注入で確認してから宣言。

品質・FFTサイズ・ホストサンプルレートの変更時は非RTで新インスタンス生成。リロード操作はUIから可能だが、同じファイル名の無断監視ホットリロードは既定OFF。変更検知時は「新しい内容がある」通知と明示Reload。ユーザーが固定した旧バージョンを外部同期・上書きで勝手に置換しない。

## 7. GUIとドラッグ＆ドロップ

主画面の上部に**DSP処理モジュール**セクションを配置：
- 現在の処理名・version・読み込んだ単一ファイル・ABI/互換状態。
- `処理ファイルを開く`（OSファイル選択）、`ドラッグ＆ドロップ`（`.fwengine`のみ許可）、`再読込`、`前の処理へ戻す`、`無効化/Bypass`。
- ロード進捗と失敗理由を別途表示。既存の周波数変換UI/グラフ/🔗連動を維持。モジュール固有のパラメータは検証済みdescriptorに従って動的にGUI内へ描画し、固定ParamIDスロット経由でHost automationへ接続。
- DAW/プラットフォームがOSのdrop eventsを奪う場合がある。**Browseを常時代替経路**として維持。DAW音源クリップのドロップと `.fwengine` のファイルドロップを混同しない。モジュールファイルをトラックへドロップしてVST3を自動インストールする意味ではない。
- drop UIは pathを丸ごとログへ記録せず、信頼境界外のファイル名表示をsanitize、巨大ファイルや破損ZIPには即時拒否、処理中の連打や多重ロードをqueue/coalesce。
- 値の範囲外／単位非互換／未実装エンジンモードは明示。公開Web版の外観を1:1ピクセル複製する義務はないが、既存の意味・値・表示精度を変えない。

## 8. 状態保存・プロジェクト再現・セキュリティ

DAW project/stateには**スキーマ付き状態** `state_schema_version`, 固定Host ParamIDの値、モジュールengine-id/version/content SHA-256、slot binding、必要なDSP内部状態、GUI表示単位、link状態を記録。外部ファイルの絶対パスだけを保存しない。承認したモジュールを管理用ライブラリにcontent-hash単位でコピーする。ファイルが見つからない・hash不一致・ABI不一致・slot契約違反・署名不明等なら**安全なDry/Bypass（既知PDC遅延維持）＋明示Missing/Incompatible**、音を別アルゴリズムで黙って出さない。復元時の強制自動更新はしない。セッション内の状態移行／エンジン切替でサウンドが変わったことを示す。

WASM runtimeはWASIの一般的なネットワーク、ファイル、スレッド、OS機能をimportしない。許可する最小関数／メモリだけを固定。入力・出力リングバッファのポインタ越境、NaN/Inf、超巨大音声、負担の大きいautomation、トラップ／予算切れ／panicを故障注入で検証。プロセス分離は将来の安全性選択肢として残す（追加latency・複雑性を伴う）。macOS署名済みバンドル内部に外部WASMを書込まない設計とする。

## 9. 実装ロードマップとacceptance

| Gate | 作業 | 受入 |
|---|---|---|
| S0 | この仕様・監査 #80 とVST3 SDK API検証を記録 | 現行仕様から未達範囲を偽らない。正式VST3バイナリなし。 |
| S1 | DSP Module Contract v1 / ZIP manifest JSON schema / WASM Rust shim とpure loader tests | 別途DSPファイルのみ改版して同じloaderで出力が変わる。壊れたmoduleを拒否。 |
| S2 | Windows x64 固定 VST3 Shell+Editor/Host ParamID/PDC/状態保存 | Steinberg Validator、Test Host、FL Studio、もう一つのホストで単純Gain/Bypassなどを正常ロード。 |
| S3 | Swap/D&D/Browse/Reload/rollback & RT安全 | モジュール差替えでVST3再ビルド無し。再生中の切替or安全な停止切替を試験。破損ロード時は音声維持。 |
| S4 | 現行Rust `Stream` を `fwengine` 用WASM Adapterから呼出し、Web/native数式の一致とパラメータを検証 | dry/wet、L/H、invert、反射、Ring、Crusher等、正本の同一信号fixtureでPCM比較。 |
| S5 | RT/品質/Hostパッケージ監査 | Fs 44.1/48/96k、mono/stereo、可変 1..2048frames、in-place、無バッファparam flush、トランスポート停止/再開、プリセットsave/load、automationスイープ、CPU/heap/fault、休止復帰／複数インスタンス。 |
| S6 | 音響製品受入、配布 | #48 Aニュートラル劣化、#5 R2.2/R2.3、#62 Web/iOS独立などを分けて評価。配布は正式なビルド・署名と製品品質受入後。 |

最低限の品質試験：純音／和音／非整数周波数／sweep／noise／attack、DC・Nyquist・L/H境界、負周波数反射、モジュールruntimeオーバーバジェット、ステレオ整合、処理中サンプルレート変更、同時複数DAW instances、ホストの再スキャン・保存復元。失敗はIssueとして明示し、シェル構造の成功と音質承認を混同しない。

初期phaseで公開するのはまず**シェル＋安全なGain/Identityテストエンジン**。現行A/Bはその後移植する。既存Web版/研究コードは並行運用し、研究中のR2方式を無断で製品標準へ格上げしない。製品配布・releaseを伴う時はdevflowと現行の承認規則に従う。

## 10. API根拠・仕様管理

Steinbergが規定する分離・process threading/automation・保存復元: [API Documentation](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/API%2BDocumentation/Index.html)。Host ParamID個数・IDの安定性、タイトル変更の仕組み: [Communication FAQ](https://steinbergmedia.github.io/vst3_dev_portal/pages/FAQ/Communication.html)。SDK提供の検証: [Validator](https://steinbergmedia.github.io/vst3_dev_portal/pages/What%2Bis%2Bthe%2BVST%2B3%2BSDK/Validator.html)。

**変更規則**: このv0.1はVST3 Shell/Module契約の基準。いったん公開したParamID/engine major ABI/module identityの非互換変更は破壊的変更として新Issue/移行手順で扱う。DSP音質やUI単位導入の未受入条件を、この文書が自動的に完了させることはない。CPU実測、SDK Validator／DAW実機実行、WASM runtimeの選択は実装Gateで確定する。
