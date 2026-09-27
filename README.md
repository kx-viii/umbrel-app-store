# Home Apps

Community app store for umbrelOS.

## qBittorrent VPN

qBittorrent routed through [Gluetun](https://github.com/qdm12/gluetun) to Proton VPN (WireGuard, port forwarding on).
qBittorrent shares Gluetun's network, so it has no internet access at all when the VPN is down.

### Setup

1. **Proton VPN:** a paid plan (Plus or higher) is needed for P2P. In the Proton dashboard go to
   Downloads > WireGuard configuration, pick platform **Router** (or GNU/Linux), turn on
   **NAT-PMP (Port Forwarding)**, choose any P2P server and create the config. Copy the `PrivateKey` line's value.
2. **Add this store to Umbrel:** App Store > ⋯ > Community App Stores > paste this repo's URL.
3. **Install "qBittorrent VPN"** from the store.
4. **Add the key:** right-click the app > Settings > Advanced > Custom variables, add
   `WIREGUARD_PRIVATE_KEY` for the `gluetun` service. Optionally add `SERVER_COUNTRIES` (e.g. `United States`). Save.
   Never commit the key to this repo.
5. **qBittorrent web UI** (login `admin` / `adminadmin`): change the password under Tools > Options > WebUI.
   On first start, `hooks/post-start` configures qBittorrent for the Umbrel proxy, allows localhost
   (so Gluetun can set the forwarded port) and the Umbrel app network (Radarr/Sonarr) without a password,
   and keeps the save path at `/downloads`.
6. **Radarr and Sonarr:** Settings > Download Clients > add qBittorrent, host `home-qbittorrent-vpn_gluetun_1`,
   port `8080`, no username/password. Remove the old Transmission/qBittorrent clients.

### Check it's working

In qBittorrent go to Tools > Options > Connection. The listening port should be a Proton-assigned
number, not 6881. Then add a torrent IP checker, such as the magnet link from
[ipleak.net](https://ipleak.net) ("Torrent Address detection"). It should show a Proton IP, not your home IP.
