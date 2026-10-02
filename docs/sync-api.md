# Web/将来のネイティブが共有する同期契約

認証は既存のHttpOnlyセッション。変更APIは `Origin` が `APP_ORIGIN` と一致する必要がある。単一所有者の保存先を不透明な `scope` UUIDで識別し、認証パスワード変更でセッションを失効させてscopeを更新する。scopeが変わった端末outboxを自動送信しない。

| 操作 | 契約 |
|---|---|
| `GET /api/state` | scope、最近のCapture/View、AIの状態。アプリの読書キャッシュの基点 |
| `POST /api/captures` | JSON文章またはmultipart原ファイル。`Idempotency-Key`を再送でも保持。原資料を保存しただけで解析成功にはしない |
| `POST /api/captures/:id/assets` | 同じリクエストキーと `X-Capture-Version` で補足。対象版が変われば409 |
| `PATCH /api/captures/:id` / `PATCH /api/views/:id` | 本文の `version` で楽観ロック。UUIDの `X-Operation-Id` を保持して再送。適用と受領記録は同じD1バッチ |
| `DELETE /api/captures/:id` | version・操作IDで削除。削除済み保存キーは410、同じCaptureを自動復活させない。採用済みViewの本文と履歴は保持 |
| `GET /api/sync?cursor=N` | 単調増加sequence、capture/view、ID、version、upsert/delete。100イベント/ページ、cursor・has_more・high_watermark・scope。カーソルが現在のDB範囲を超えればreset |

受領記録の操作IDを別のパス・方法・本文へ使うと409。同期イベント・tombstoneは元本文を含めない。現時点では履歴を自動刈り込みしない。削除通知をキャッシュに適用してからカーソルを進め、途中中断なら同じ通知を再適用する。

Web端末は送信前に原ファイルBlob/文章・パス・方法・版・操作IDをIndexedDBへ書く。応答確認までは削除しない。容量不足や通信断で、他の未送信データを消去しない。サーバーの400/404/409/410/413は自動上書きせず、元の内容と取得できた現行版を競合として保存する。

競合解決時は本人が現行版と端末の内容を確認する。その後で保存先が変われば再確認を要求する。元の原文/メモ/見方を黙って捨てるlast-write-winsは使わない。未送信の削除には専用の確認、未送信の書き出しには原ファイルbase64付きJSONを用意する。

ログアウト/認証失効は読書キャッシュを消し、未送信の原資料は保持する。同じ所有者の再認証後に続行する。オフラインで閉じた端末はオンラインCookieが残っていても、再認証するまで自動解除しない。ネイティブアプリ自体はまだ実装していない。
