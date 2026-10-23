# jr-delay-notify

JR北海道の列車遅延情報を監視し、運行状況の変化をLINEに通知するCloudflare Worker。

平日の通勤時間帯（朝6〜9時・午後14〜20時）に5分ごとにポーリングし、遅延発生・復旧を検知したタイミングでLINEブロードキャストを送信する。

## アーキテクチャ

```
Cloudflare Workers (Cron Trigger)
  └─ scraper.ts   … JR北海道 JSON API をフェッチ・パース
  └─ state.ts     … 前回状態を KV Namespace に保存・比較
  └─ message.ts   … LINE 送信テキストを組み立て
  └─ line.ts      … LINE Messaging API (broadcast) 呼び出し
  └─ config.ts    … 監視対象・エンドポイント定義
```

状態は `JR_STATE` KV Namespace に JSON で保管される（TTL 365日）。状態（ステータス・概況テキスト・通知フラグ）が変化したときのみ KV 書き込みが発生する（無料枠節約）。

## 監視対象（デフォルト）

| ID | 路線 | エリア |
|---|---|---|
| `hakodate-sapporo` | 函館・千歳線（札幌近郊） | spo |
| `spo-airport` | エアポート（札幌近郊） | spo |

`src/config.ts` の `DEFAULT_TARGETS` を編集して変更できる。

## Cron スケジュール

| cron (UTC) | JST | 意図 |
|---|---|---|
| `*/5 21-23 * * 0-4` | 月〜金 06:00〜08:59 | 朝の通勤 |
| `0 0 * * 1-5` | 月〜金 09:00 | 朝の通勤終了 |
| `*/5 5-10 * * 1-5` | 月〜金 14:00〜19:59 | 帰りの通勤 |

> JST 09:01〜13:59 は意図的に対象外（昼間ギャップ）。

## セットアップ

### 前提

- Node.js 20+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare アカウント
- LINE Messaging API チャンネル（ブロードキャスト権限）

### 手順

```bash
# 1. 依存インストール
npm install

# 2. KV Namespace を作成し、wrangler.jsonc の id/preview_id を更新
wrangler kv namespace create JR_STATE
wrangler kv namespace create JR_STATE --preview

# 3. シークレットを登録
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
wrangler secret put CHECK_SECRET   # /check エンドポイント用（任意）
wrangler secret put LINE_TO        # push 送信先の userId/groupId（任意）
wrangler secret put HEARTBEAT_URL  # 死活監視用 ping URL（任意）

# 4. デプロイ
npm run deploy
```

main への push で GitHub Actions がテスト・型チェック・dry-run の後に自動デプロイする。手動デプロイは `npm run deploy`。

自動デプロイには GitHub の設定が必要。

| 種別 | 名前 | 内容 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Workers の編集権限を持つ API トークン |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID |
| Variable | `KV_NAMESPACE_ID` | `JR_STATE` の KV namespace id（デプロイ時に `wrangler.jsonc` のプレースホルダーを置換する） |

`LINE_CHANNEL_ACCESS_TOKEN` などの Worker 用シークレットは Cloudflare 側に登録済みのものが使われる。

### ローカル開発

```bash
npm run dev   # wrangler dev (ローカル KV はインメモリ)
```

シークレットを使う場合は `.dev.vars`（git ignore 済み）に記述する。`wrangler dev` が自動で読み込む。

```ini
LINE_CHANNEL_ACCESS_TOKEN=your_token_here
CHECK_SECRET=any_string
```

### テスト

```bash
npm test
```

### ログ確認

```bash
wrangler tail   # ライブログをリアルタイムで確認
```

Cloudflare ダッシュボードの Workers Logs（`wrangler.jsonc` で `observability.enabled: true` を設定済み）でも確認できる。

## 環境変数 / シークレット

| 名前 | 種別 | 必須 | 説明 |
|---|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | Secret | ✅ | LINE チャンネルアクセストークン |
| `CHECK_SECRET` | Secret | | `/check` エンドポイントの認証トークン |
| `LINE_TO` | Secret | | 送信先の userId / groupId。設定すると push API で宛先を絞って送る（未設定時は友だち全員へ broadcast） |
| `HEARTBEAT_URL` | Secret | | 全ターゲットが成功した cron 実行のたびに GET する URL（Healthchecks.io など）。停止検知用 |
| `NOTIFY_ON_RECOVERY` | Var | | `"false"` で復旧通知を無効化（デフォルト: `true`） |

## 死活監視（Heartbeat）

`HEARTBEAT_URL` を設定すると、全ターゲットの取得に成功した cron 実行の末尾でその URL に GET を送る。cron の停止や、取得失敗が続く状態を外部の監視サービス側で検知できる。

監視側の期間は cron の稼働時間帯に合わせる。平日の通勤時間帯のみ動くため、週末や昼間ギャップ（JST 09:01〜13:59）に ping が来なくても誤報にならないよう、期待間隔と猶予時間を広めに設定する。

## HTTP エンドポイント

| パス | 説明 |
|---|---|
| `GET /` または `/health` | 死活確認 |
| `GET /check` | 手動トリガー（要 `X-Check-Secret` ヘッダー）。LINE 通知が発火するため月200件の無料枠に注意 |

### /check レスポンス例

```json
{
  "ok": true,
  "results": [
    { "id": "hakodate-sapporo", "label": "函館・千歳線（札幌近郊）", "status": 0, "description": "現在、遅れに関する情報はありません。", "notified": false }
  ]
}
```

## 通知フォーマット

**遅延発生**
```
⚠️ 【運行情報】函館・千歳線（札幌近郊）

エリア概況: …（JR北海道公式テキスト）

（2026年06月21日 07時30分現在）
詳細: https://www3.jrhokkaido.co.jp/webunkou/
```

**復旧**
```
✅ 【復旧情報】函館・千歳線（札幌近郊）

運行が正常に戻りました。

（2026年06月21日 08時00分現在）
```

## 監視対象の追加

`src/config.ts` の `DEFAULT_TARGETS` に追加する。

```ts
{
  id: "spo-express",
  label: "特急（札幌近郊）",
  areaKey: "spo",
  senkuKey: "express",
}
```

利用可能な `senkuKey`（spo エリア）: `express`, `airport`, `hakochise`, `hakodateLiner`, `hakodate`, `gakuen`, `sekisho`, `muroran`, `nemuro`, `hidaka`, `soya`, `sekihoku`, `furano`, `rumoi`, `senmo`, `hanasaki`

他エリアのキーは各 area JSON を直接参照のこと。
