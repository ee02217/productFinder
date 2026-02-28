# VPN Configuration

Place your OpenVPN configuration file here as `client.ovpn`.

## Supported VPN Formats

- **OpenVPN**: `client.ovpn`
- **Wireguard**: `wireguard.conf` (place in `vpn/wireguard/`)

## Usage

### Option 1: Manual VPN Start
```bash
# Build and start without VPN first
docker compose up -d --build

# Then exec into the container and start VPN manually
docker exec -it product-finder-app-1 openvpn --config /app/vpn/client.ovpn
```

### Option 2: Auto-connect on container start
Uncomment the VPN startup lines in `docker-compose.yml`.

### Environment Variables

Add to `.env`:
```
VPN_ENABLED=true
VPN_CONFIG=/app/vpn/client.ovpn
```

## Testing VPN Connection

```bash
# Check IP from inside container
docker exec product-finder-app-1 curl -s ifconfig.me

# Or check what's your public IP
docker exec product-finder-app-1 curl -s https://api.ipify.org
```

## Notes

- The VPN connection must be active BEFORE starting the scraper
- All traffic from the container will go through the VPN
- Your host machine's IP will not be exposed to Continente's servers
