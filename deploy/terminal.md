# Website terminal

`/terminal/` serves the unmodified [ttyd](https://github.com/tsl0922/ttyd) frontend. It opens a shell on the current server as its administrator, with no second login or stored SSH private key. This is a host shell over the website's authenticated WebSocket, rather than an outbound SSH connection manager.

Install ttyd from the server distribution's signed package repository and disable the package's default TCP-listening `ttyd.service`. Install and enable `study-terminal.service` instead. Its only listener is `/run/study-terminal/ttyd.sock`; Caddy shares the containing directory read-only. `RuntimeDirectoryPreserve=yes` retains the directory across service restarts so the Docker bind mount keeps seeing newly created sockets. The directory is root-only and no terminal TCP port is opened.

Caddy checks the existing website owner session on every request, including WebSockets; it rejects wrong-Origin upgrades and unsafe requests. Only the authentication subrequest drops Upgrade/Connection. Caddy overwrites X-WEBAUTH-USER after authentication and strips upstream Authorization. ttyd also enables its native Origin check and proxy-header authentication. See the [upstream auth-proxy documentation](https://github.com/tsl0922/ttyd/wiki/Auth-Proxy).

Preserve `/terminal` when proxying: ttyd's `-b /terminal` handles its HTML, token endpoint and WebSocket. The website navigation uses a normal anchor so Next.js does not intercept the standalone application.

Before activating, preserve the old proxy configuration, start the private terminal service, validate Caddy and merge reviewed configuration after CI. Apply only the new socket mount to the deployed proxy service; preserve all other deployment-specific Compose settings. Recreate the proxy to refresh bind mounts, keeping the current website application version until the normal release process switches it.

Verify anonymous HTML redirects to the original login, anonymous/forged identity access fails, wrong-Origin WebSockets fail, and an owner-authenticated WebSocket runs a benign UID/current-directory command and reconnects. Check the real browser frontend and website/Hermes health. Installation, merged code or a built image alone do not establish production activation.
