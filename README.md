# mf_notify-web

[mf_notify](https://github.com/myumoon/mf_notify) の設定画面（GitHub Pages）。

画面: https://myumoon.github.io/mf_notify-web/

設定（`settings.yml`）は利用者ごとの GitHub **private** リポジトリに置き、この画面から読み書きします。画面はブラウザだけで動き、トークンはブラウザの localStorage にだけ保存されます（このリポジトリやサーバーには送りません）。

## 画面の使い方

1. データ用リポジトリを用意する: テンプレート [myumoon/mf_notify-data-template](https://github.com/myumoon/mf_notify-data-template) の「Use this template」→ **Private** で作成。
2. 画面を開き「接続」で次のどちらかを行う。
   - **GitHub でログイン**（表示されている場合）: ログイン後、「アプリをインストール」でデータ用リポジトリにアプリを入れ、一覧からリポジトリを選ぶ。
   - **トークンを貼り付け**: 下の「fine-grained PAT の作り方」で作ったトークンと `owner/repo` を入れて「接続」。
3. フォームを編集する。誤りがあると項目の下に赤字で出て、「保存」が押せなくなります。
   - 支出カテゴリは「大項目」または「大項目＋中項目」。候補は PC 側（mf_notify）が書き出す `categories.json` から選びます。大項目まとめては中項目で「（大項目全体）」、候補に無い名前は「その他（自由入力）」を選んで入力します。中項目を選んでいない行があると保存できません。`categories.json` が無いときは文字で入力します。
   - 支出カテゴリは「大項目を選んで中項目をまとめて追加」で、その大項目の中項目のうちまだ無いものを一度に行として足せます。`categories.json` は MF の設定ページにある全カテゴリ（使っていない標準の中項目や「未分類」も含む）になるので、まとめて追加はその大項目の全中項目を足します。不要な行は削除してください。
   - カテゴリは ID（`"11"` / `"11/41"`）で保存し、画面には `categories.json` の対応表で今の名前を出します（並びは MF の順）。MF で中項目名を変えても、次に PC 側で `run` した後は新しい名前で表示されます。対応表に無い ID は「不明なカテゴリ（<キー>）」と表示し、値は消さずに残します。自由入力した名前は、対応表にあれば ID に変えて保存します。
   - 予算は支出カテゴリごとの月予算だけを入力します。「予算合計」には積立以外のカテゴリ月予算の合計（月）と、そこから導いた年（月×12）・週（月×12÷52、円未満切り捨て）が自動で表示されます。カテゴリ予算が 1 件も無いときは「未設定」です。
   - 収入カテゴリ・貯金目標・年／月／週の予算欄はありません。既存の `settings.yml` にある `categories`（収入）・`savings`・`budgets.yearly` / `monthly` / `weekly` は保存時に削除されます（`budgets.monthlyByCategory` は残ります）。
   - 秘密情報の欄には `op://…` の参照（または環境変数名）だけを書きます。値そのものは書かないでください。
4. 「YAML を確認」で保存される内容を確認し、「保存」。
   - 「他で更新されています。再読込してください」と出たら、別の端末などで先に保存されています。「再読込」してから編集し直してください。
5. 「切断」でこのブラウザに保存したトークンとリポジトリ名を消します。

### カテゴリ ID への移行

mf_notify 本体のカテゴリ ID 対応（myumoon/mf_notify#30）と同じ日に、この画面も更新してください。本体が `run` すると `stats.json` のキーが ID になり、古い画面では予算の提案・月別の集計が 0 件になります（本体の通知の動作は変わりません）。

1. 本体を更新し、PC で `run` を 1 回実行する（`categories.json` に ID の対応表 `majors` が入る）。
2. この画面で設定を開く。名前で書かれたカテゴリは自動で ID に変換され、「カテゴリを ID 形式に変換しました。内容を確認して保存してください」と表示されます。対応表に無い名前は名前のまま残し、件数と名前を表示します。
3. 内容を確認して「保存」する。保存するまで `settings.yml` は書き換えません（保存しなくても本体は名前・ID のどちらでも動きます）。

`categories.json` に `majors` が無い（本体が古い・まだ `run` していない）ときは変換せず、従来どおり名前で編集できます。`stats.json` が名前キーのままなら、提案は名前キーの設定にだけ出ます。保存した YAML では数字だけのキーが `'11'` のように引用符付きになり、大項目まるごとのキー（`'11'` など）が `majors`・`monthlyByCategory` の先頭に並びます（値は変わりません）。

## fine-grained PAT の作り方

1. GitHub の Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token。
2. Repository access: **Only select repositories** でデータ用リポジトリを **1 つだけ** 選ぶ。
3. Permissions → Repository permissions: **Contents: Read and write**（Metadata: Read-only は自動で付きます）。
4. 有効期限は任意。期限が切れたら作り直して貼り直してください。

PC 側（mf_notify）でも同じ種類のトークンを使います（1Password に入れて `op://` で参照）。

## GitHub でログインを使う（任意・作者向け）

トークンを貼らずに「GitHub でログイン」できるようにするには、GitHub App とトークン交換用の Worker を用意し、`config.js` に値を書きます。`config.js` が空のままなら、ログインボタンは表示されず貼り付けだけになります。

### 1. GitHub App を登録する

GitHub の Settings → Developer settings → GitHub Apps → New GitHub App。

| 項目 | 値 |
| --- | --- |
| Homepage URL | 画面の URL（例: `https://<user>.github.io/mf_notify-web/`） |
| Callback URL | 画面の URL（上と同じ。末尾の `/` まで一致させる） |
| Expire user authorization tokens | **OFF**（画面はトークンの更新をしません） |
| Request user authorization (OAuth) during installation | ON |
| Webhook | Active を OFF |
| Repository permissions | **Contents: Read and write**、**Metadata: Read-only** |
| Where can this GitHub App be installed? | 自分だけなら Only on this account、公開するなら Any account |

登録後、**Client ID** を控え、**Generate a new client secret** でシークレットを作る（Worker に登録する。画面や `config.js` には書かない）。App の URL 名（`https://github.com/apps/<slug>` の `<slug>`）も控える。

### 2. Worker をデプロイする（Cloudflare Workers 無料枠）

`worker/` は code をトークンに換えるだけで、データを保存しません。

```sh
cd worker
# wrangler.toml の [vars] を書く: GITHUB_CLIENT_ID = Client ID、ALLOWED_ORIGIN = 画面のオリジン（例: https://<user>.github.io。パスは付けない）
npx wrangler login
npx wrangler deploy
npx wrangler secret put GITHUB_CLIENT_SECRET   # 1. で作った client secret を貼る
```

デプロイ後に表示される URL（例: `https://mf-notify-token.<account>.workers.dev`）を控える。

### 3. config.js に書く

```js
export const CLIENT_ID = 'Iv23li...';                                        // GitHub App の Client ID
export const TOKEN_ENDPOINT = 'https://mf-notify-token.<account>.workers.dev/token'; // Worker の URL + /token
export const APP_SLUG = 'your-app-slug';                                      // App の URL 名
```

main に push すると GitHub Pages に反映されます。

## 開発

ビルド・npm 依存はありません（`vendor/js-yaml.min.js` は js-yaml 4.1.0 を同梱）。

```sh
node --test test/                    # テスト（Node 24）
python -m http.server 8000           # http://localhost:8000/ で画面を確認
```

ローカルで「GitHub でログイン」を試す場合は、GitHub App の Callback URL と Worker の `ALLOWED_ORIGIN` を `http://localhost:8000` 向けにした別の App / Worker を使ってください。
