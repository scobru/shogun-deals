# Shogun Protocol - Storage Deals Standalone App

Standalone web application for creating and managing storage deals on the Shogun Protocol.

## Features

- **On-Chain Deal Creation**: Create storage deals directly on-chain via StorageDealRegistry
- **Relay Discovery**: Browse and select from active relays in the ShogunRelayRegistry
- **Deal Management**: View and manage your storage deals
- **Pricing Calculator**: Calculate storage costs for different tiers
- **Wallet Integration**: Full MetaMask/Web3 wallet support

## Architecture

This app interacts directly with on-chain contracts:
- **ShogunRelayRegistry**: For discovering active relays
- **StorageDealRegistry**: For creating and managing storage deals
- **USDC**: For payments and staking

## Usage

1. Open `index.html` in a web browser
2. Connect your MetaMask wallet
3. Select a network (Base Sepolia or Base Mainnet)
4. Browse available relays
5. Create storage deals on-chain

## Contract Addresses

### Base Sepolia (Testnet)
- ShogunRelayRegistry: `0x644EA4f01fE1b444E4Dfe2Bc06A0FE916D1ffD28`
- StorageDealRegistry: `0x7E0C8c90EF384622dff9CF836125E20D76F003d1`
- USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

### Base Mainnet
- TBD

## Pricing Tiers

- **Standard**: $0.0001 per MB/month, 1x replication
- **Premium**: $0.0002 per MB/month, 3x replication, erasure coding
- **Enterprise**: $0.0005 per MB/month, 5x replication, erasure coding, SLA

## Development

### Using Vite (Recommended)

```bash
# Install dependencies
yarn install

# Start development server
yarn dev

# Build for production
yarn build

# Preview production build
yarn preview
```

The Vite dev server runs on `http://localhost:5174` and proxies API requests to the relay at `http://localhost:8765`.

### Without Vite (Legacy)

You can also open `index.html` directly in a browser, but you'll need to:
- Configure CORS on the relay
- Handle API requests manually
- Use a different port for the relay

For production with Vite:
- Host the built files from `dist/` directory
- The build includes minification and optimization

## License

Part of the Shogun Protocol ecosystem.
