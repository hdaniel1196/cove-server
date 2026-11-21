# Install Cove Server

Cove Server puts one address in front of your media servers. Your family signs in to Cove once and gets movies and shows (Jellyfin), books (Kavita, optional) and requests (Seerr, optional), with levels for kids and teens, sagas, Live TV and settings that follow them to every device.

## What you need

- A computer that's always on: Windows, a Mac, or anything with Docker (Linux, a NAS).
- A Jellyfin server you're an admin of. Kavita and Seerr are optional.

## On Windows (no Docker needed)

1. Unzip **Cove Server for Windows** and double-click **Install Cove Server.cmd**. Say Yes when Windows asks for permission.
2. Cove Server installs as a service, so it starts with Windows even before anyone signs in. A Cove icon appears by the clock, and your browser opens the setup page with the setup code shown in the install window.
3. Follow the setup page (step 3 below). Other devices at home open `http://<this PC's name or address>:5050`.

The Cove icon by the clock has Open Cove, Show setup code and Open data folder. Settings live in `C:\ProgramData\Cove Server` (back it up). To update, run the new installer. To remove it, run **Uninstall Cove Server.cmd** (your settings stay). If Windows says "Windows protected your PC", choose More info → Run anyway.

## On a Mac

You need a Mac with Apple Silicon (M1 or newer) on macOS 13 Ventura or later.

1. Open **Cove Server.dmg** and drag **Cove Server** onto **Applications**.
2. Open Cove Server from Applications. A Cove icon appears in the menu bar, and your browser opens the setup page.
3. If your Mac asks whether Cove Server can accept incoming connections, choose **Allow**, so other devices at home can reach it.
4. Follow the setup page (step 3 below). Your setup code is under the Cove icon: **Show setup code**. Other devices at home open `http://<this Mac's name or address>:5050`.

Cove Server starts by itself when you sign in to your Mac, and comes back on its own if it ever stops. The Cove icon shows whether it's running or waiting for setup, and has Open Cove, Show setup code and Open data folder. **Quit Cove Server** stops it until you open the app again or sign in next time. Settings live in `~/Library/Application Support/Cove Server` (back it up), and the log is `cove-server.log` in that folder. Keep the Mac from sleeping (System Settings → Energy, or Battery → Options on a laptop) so people can watch while you're away from it.

To update, quit Cove Server, drag the new one into Applications and open it. To remove it, choose **Remove Cove Server from this Mac** under the Cove icon, then drag the app to the Trash (your settings stay).

## With Docker

### 1. Start it

Save this as `docker-compose.yml` in a new folder, then run `docker compose up -d` in that folder.

```yaml
services:
  cove-server:
    image: cove-server:latest
    container_name: cove-server
    restart: unless-stopped
    ports:
      - "5050:80"
    environment:
      - TZ=America/Chicago        # your time zone
    volumes:
      - ./data:/data              # settings, keys and people: back this folder up
networks:
  default:
    ipam:
      config:
        - subnet: 10.89.0.0/24    # a small range of its own (see "Good to know")
```

### 2. Get the setup code

Run `docker logs cove-server`. You'll see a line like:

```
Cove Server isn't set up yet. Open it in a browser and use this setup code:  ABCD-EF23
```

The code makes sure only you can set up your server.

## 3. Follow the setup page (every version)

Open `http://<this computer's address>:5050` in a browser. The setup page asks for:

1. **The setup code.**
2. **A name for your server, and your email.** You're the owner. You sign in with this email and your Jellyfin password.
3. **Jellyfin:** its address, plus your Jellyfin admin user name and password. Cove makes its own Jellyfin API key.
4. **Kavita** (optional): its address and the admin's auth key (Kavita: your profile → 3rd Party Clients → Auth Keys).
5. **Seerr** (optional): its address and API key (Seerr: Settings → General).
6. **Addresses:** where people reach Cove at home, and from outside (optional, https only).

**Addresses in Docker:** `localhost` means Cove itself (on Windows and Mac it's fine). Use the computer's network address (like `http://192.168.1.20:8096`), or the container's name if Jellyfin runs on the same Docker network as Cove.

## 4. Add your family

Sign in, then go to Server → Users → Add Person. Pick each person's level (member, teen or kid). Cove makes their Jellyfin account, plus their Kavita and Seerr accounts if those are connected. Send them their invite link, or set their password yourself.

**Kids** only see titles with the **Kids** tag. Teens see **Kids** and **Teens**. Tag titles from a movie or show's page in Cove (Edit → Tags).

## Reaching Cove from outside the house

Cove serves plain http on port 5050. For outside access, put HTTPS in front of it with any of these:

- **Cloudflare Tunnel:** no open ports. Direct a hostname at `http://cove-server:80` in Docker, or `http://localhost:5050` on Windows and Mac.
- **Caddy** or another reverse proxy, with your own domain and a port forward for 443.
- **Tailscale:** private access for your own devices only, no domain needed.

Then put that https address in Cove's settings. Face ID sign-in turns on with it.

## Good to know

- **Back up the `data` folder.** It holds the settings, Cove's keys and your people.
- **Updating:** pull the new image, then `docker compose up -d`. Settings stay in `data`.
- **The network range:** Docker can hand a new network a 192.168.x range that clashes with your home network, and then Cove can't reach Jellyfin. The `subnet` line in the compose file prevents that.
- **Members editing their own sagas (optional):** mount Jellyfin's `config/data/playlists` folder read-only at `/jfplaylists`. Without it, only admins edit sagas.
