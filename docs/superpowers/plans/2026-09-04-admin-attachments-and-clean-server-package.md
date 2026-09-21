# FastQQ Admin Attachments and Clean Server Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make admin chat attachments viewable through an authenticated endpoint and generate a clean, data-free server package that can start on another Windows PC after Node.js is installed.

**Architecture:** The admin service will share the root `uploads/` directory with the main server and expose file bytes only through its existing Bearer-authenticated API. The admin browser will fetch Blob objects and create temporary object URLs. A focused Python packaging module will build the portable server ZIP from an explicit allowlist and validate a denylist before reporting success.

**Tech Stack:** Node.js HTTP server, SQLite, browser JavaScript/XHR Blob APIs, Python `zipfile`, Windows batch/PowerShell deployment helpers, Node test runner, Python `unittest`.

---

## File map

- Modify `admin/admin.js`: correct upload root and add authenticated attachment content response.
- Modify `admin/public/panel.js`: authenticated Blob loading, image preview, lightbox, and attachment download.
- Modify `tests/admin.test.js`: integration coverage for upload listing/content/auth/path safety.
- Modify `tests/admin-ui.test.js`: static UI regression checks for protected Blob usage.
- Create `scripts/server_package.py`: allowlisted clean server ZIP builder and validator.
- Create `scripts/check-server-environment.ps1`: read-only Node/files/ports environment report.
- Create `docs/新电脑服务器部署说明.txt`: Chinese deployment and first-start instructions.
- Modify `scripts/package_dist.py`: invoke the clean server package builder.
- Modify `scripts/build_all.py`: report the new artifact.
- Create `tests/test_server_package.py`: package contents and exclusions tests.
- Modify `README.md`: document the new server package.

### Task 1: Reproduce and fix backend attachment access

- [ ] Add an isolated fixture under `uploads/` in `tests/admin.test.js`; assert `/api/admin/files` lists it and `/api/admin/files/content?file=<name>` returns exact bytes with a valid token.
- [ ] Add assertions that the same content endpoint returns 401 without a token, 400 for `../qq_chat.db`, and 404 for a missing file.
- [ ] Run `node --test tests/admin.test.js` and confirm the listing/content assertions fail because the admin currently uses `public/uploads` and has no content route.
- [ ] Change `UPLOADS_DIR` in `admin/admin.js` to `path.join(ROOT_DIR, 'uploads')`.
- [ ] Add a safe resolver that rejects empty names, names changed by `path.basename`, directories, and resolved paths outside `UPLOADS_DIR`.
- [ ] Add `GET /api/admin/files/content` inside the authenticated admin route block. Return a mapped MIME type, `Content-Length`, `X-Content-Type-Options: nosniff`, and `Content-Disposition: inline` or `attachment` based on `download=1`.
- [ ] Ensure the test fixture is deleted in test teardown and rerun `node --test tests/admin.test.js` until green.

Expected endpoint shape:

```js
GET /api/admin/files/content?file=photo.png
Authorization: Bearer <admin token>

200 Content-Type: image/png
<binary bytes>
```

### Task 2: Render protected attachments in the admin UI

- [ ] Add failing checks to `tests/admin-ui.test.js` for `fetchAdminBlob`, `data-admin-file`, `URL.createObjectURL`, `URL.revokeObjectURL`, and authenticated download handling.
- [ ] Run `node --test tests/admin-ui.test.js` and confirm failure on the missing protected attachment helpers.
- [ ] In `admin/public/panel.js`, implement `fetchAdminBlob(fileName, download)` using XHR `responseType = 'blob'` and the current Bearer token.
- [ ] Track created object URLs in `state.attachmentObjectUrls`; revoke them before each message/file rerender and at logout.
- [ ] Render message images and file-asset thumbnails with `data-admin-file` instead of direct `/uploads/...` URLs, then hydrate their `src` from authenticated Blob responses.
- [ ] Replace direct file anchors with buttons that fetch the Blob, create a temporary `<a download>`, click it, and revoke the URL.
- [ ] Keep the existing lightbox, but pass the hydrated object URL rather than the database-relative upload path.
- [ ] Render an explicit broken-attachment label when a protected file cannot be fetched.
- [ ] Run `node --test tests/admin-ui.test.js tests/admin.test.js` until green.

### Task 3: Create and test the clean server package builder

- [ ] Create `tests/test_server_package.py` with a temporary fake project. Assert the generated ZIP contains `admin/admin.js`, `src/server.js`, `public/index.html`, `package.json`, the manager EXE, startup scripts, environment checker, deployment guide, and `cloudflared.exe` when present.
- [ ] Assert the ZIP never contains `qq_chat.db`, files inside `uploads/`, `logs/`, `backups/`, `test-logs/`, `admin-config.json`, `public-url.json`, tests, or `scripts/apk-signing-key.pem`.
- [ ] Run `python -m unittest tests/test_server_package.py` and confirm failure because `scripts/server_package.py` does not exist.
- [ ] Implement `build_clean_server_package(project_root, output_zip)` in `scripts/server_package.py` using explicit source trees and individual files rather than copying the project root.
- [ ] Add empty-directory markers only for `uploads/`, `logs/`, and `backups/`.
- [ ] Implement `validate_clean_server_package(output_zip)` to raise if required entries are absent or denied entries are present.
- [ ] Generate `docs/新电脑服务器部署说明.txt` with Node.js installation, extraction, environment check, first startup, admin password initialization, firewall/LAN, port collision, and tunnel instructions.
- [ ] Create `scripts/check-server-environment.ps1` as a read-only checker for Node.js 24+, required files, and ports 3000/3001; it must not install or modify system components.
- [ ] Rerun `python -m unittest tests/test_server_package.py` until green.

### Task 4: Integrate the server package into the full build

- [ ] Add a failing test that calls the real package builder against the project and checks the output name `dist/极速QQ-全新服务器迁移包.zip`.
- [ ] Update `scripts/package_dist.py` to call `build_clean_server_package` after client bundles are created.
- [ ] Update `scripts/build_all.py` output text and `README.md` artifact documentation.
- [ ] Run `python scripts/build_all.py` and confirm all client artifacts plus the new server ZIP are produced.
- [ ] Run the validator against the real ZIP and inspect its entry list for required/excluded content.

### Task 5: Isolated new-computer simulation and final verification

- [ ] Record the production database SHA-256 before verification.
- [ ] Extract the clean server ZIP into a fresh temporary directory outside the project.
- [ ] Run `check-server-environment.ps1` there and confirm it finds Node.js and all required files.
- [ ] Start the main and admin servers from the extracted directory with isolated ports or environment paths; verify HTTP responses and that a new empty `qq_chat.db` is created.
- [ ] Verify the extracted package contains an empty `uploads/` and no production users.
- [ ] Stop all temporary processes and remove the temporary extraction directory.
- [ ] Run `npm test`, `python -m unittest tests/test_network_utils.py tests/test_server_package.py`, `node --check admin/admin.js`, and `node --check admin/public/panel.js`.
- [ ] Re-run APK verification because the full build regenerates it.
- [ ] Confirm the production database SHA-256 and modification time are unchanged.

No commit steps are included because `D:\software` is not a Git repository.
