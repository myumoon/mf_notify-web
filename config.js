// 「GitHub でログイン」用の設定。CLIENT_ID が空ならログインボタンを出さず、トークン貼り付けだけにする。
// 値の用意は README の「GitHub でログインを使う」を参照。どれも公開してよい値（秘密は Worker 側だけ）。
export const CLIENT_ID = ''; // GitHub App の Client ID
export const TOKEN_ENDPOINT = ''; // Worker の URL + /token（例: https://mf-notify-token.<account>.workers.dev/token）
export const APP_SLUG = ''; // GitHub App の URL 名（https://github.com/apps/<APP_SLUG>）
