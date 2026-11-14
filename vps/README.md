# ytm-media (VPS side)

A googlevideo URL is signed for the IP that minted it. Cloudflare Workers
rotate their egress address between subrequests, so a Worker that mints a URL
and then fetches it intermittently gets 403. This service runs on a machine with
one fixed address, so the mint and the fetch are the same connection.

    systemctl status ytm-media
    journalctl -u ytm-media -f

Deployed at `/opt/ytm-media/server.mjs`, unit at `/etc/systemd/system/ytm-media.service`,
listening on `0.0.0.0:8080`. Requests must carry the secret path prefix that is
also in `MEDIA_PROXY` in `index.js`.

Optional: put a signed-in YouTube cookie in the unit as
`Environment=YTM_COOKIE=...` to get past the "confirm you're not a bot"
challenge that datacenter addresses receive.

To remove it entirely: `sudo systemctl disable --now ytm-media` and delete
`/opt/ytm-media` plus the unit file.
