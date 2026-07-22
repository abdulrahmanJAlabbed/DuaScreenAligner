# Publishing DuaScreen Aligner

Two artifacts, two channels. Build both with:

```bash
make dist
# → build/dua-screen-aligner@duascreenaligner.github.com.shell-extension.zip
# → build/dua-screen-aligner_<version>_amd64.deb
```

## 1. GNOME extension → extensions.gnome.org

1. Create an account at <https://extensions.gnome.org> (GNOME account, free).
2. Go to <https://extensions.gnome.org/upload/>.
3. Upload `build/dua-screen-aligner@duascreenaligner.github.com.shell-extension.zip`.
4. In the description, state clearly that **cursor correction requires the
   companion system daemon** (link the GitHub releases page) — the extension's
   alignment editor and wallpaper features work without it, cursor DPI
   correction does not. Reviewers want this disclosed.
5. Wait for human review (days to weeks). Common review requests:
   - bump `metadata.json` `version` on every re-upload
   - all timers/signals must be cleaned up in `disable()` (done)
   - no synchronous shell-blocking calls in `extension.js` (done — async DBus)
6. Each update later: bump `version` in `metadata.json`, `make pack-extension`,
   upload the new zip.

## 2. Daemon → GitHub Release (.deb)

```bash
git tag v0.2.0
git push origin v0.2.0
gh release create v0.2.0 \
  build/dua-screen-aligner_0.2.0_amd64.deb \
  "build/dua-screen-aligner@duascreenaligner.github.com.shell-extension.zip" \
  --title "DuaScreen Aligner v0.2.0" \
  --notes-file RELEASE_NOTES.md
```

Users then install with:

```bash
sudo apt install ./dua-screen-aligner_0.2.0_amd64.deb   # daemon (auto-starts)
gnome-extensions install --force dua-screen-aligner@duascreenaligner.github.com.shell-extension.zip
# log out/in, then:
gnome-extensions enable dua-screen-aligner@duascreenaligner.github.com
```

The `.deb` ships `/usr/bin/dua-screen-aligner`, the systemd unit
(`Type=dbus`, auto-activated), and the DBus system policy; `postinst`
enables + starts the service, `prerm` stops it.

## Checklist before each release

- [ ] `make test` green (go vet, race tests, schema strict, extension validate)
- [ ] `make bench` still 0 allocs/op
- [ ] `metadata.json` version bumped
- [ ] tag pushed, `make dist` rebuilt from the tag
- [ ] tested `.deb` in a clean VM if the unit/policy changed
