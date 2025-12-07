# Shogun Protocol - Storage Deals Standalone App

A standalone web application for creating and managing decentralized storage deals on the Shogun Protocol. This app provides a user-friendly interface for interacting with Shogun's on-chain storage contracts, discovering relays, and managing your storage deals.

## Overview

The Shogun Storage Deals app enables users to:
- Create on-chain storage deals with IPFS content
- Discover and select from active Shogun relays
- Manage storage deals and monitor their status
- Calculate storage costs for different service tiers
- Handle payments and staking in USDC
- Grief deals if relays fail to fulfill commitments

## Features

### Core Functionality

- **On-Chain Deal Creation**: Create storage deals directly on-chain via `StorageDealRegistry`
- **Relay Discovery**: Browse and select from active relays registered in `ShogunRelayRegistry`
- **Deal Management**: View, monitor, and manage your active storage deals
- **Pricing Calculator**: Calculate storage costs for different tiers (Standard, Premium, Enterprise)
- **Wallet Integration**: Full MetaMask/Web3 wallet support with automatic network switching
- **Dynamic Pricing**: Load pricing information directly from selected relays
- **Reputation System**: View relay reputation scores, uptime, and proof success rates
- **Griefing Mechanism**: Grief deals if relays fail to provide proofs or fulfill commitments
- **User Registration**: Register as a user and manage your GunDB encryption keys
- **Stake Management**: Deposit and manage USDC stake for relay operations

### Technical Features

- **Shogun Contracts SDK Integration**: Uses `shogun-contracts/sdk` for all contract interactions
- **GunDB Integration**: Automatic keypair derivation from wallet for encrypted data storage
- **Multi-Chain Support**: Supports Base Sepolia (testnet) and Base Mainnet
- **Real-time Updates**: Live deal status updates and relay information

## Architecture

### Contract Integration

The app interacts with the following on-chain contracts:

- **ShogunRelayRegistry**: Discovers active relays and their metadata
- **StorageDealRegistry**: Creates and manages storage deals on-chain
- **USDC (ERC-20)**: Handles payments and staking

**Important**: Contract addresses for Shogun Protocol contracts (RelayRegistry, StorageDealRegistry, etc.) are managed by the SDK and retrieved automatically via `sdk.getRelayRegistry().getAddress()`. The app only maintains hardcoded addresses for:
- USDC token addresses (not part of SDK)
- RPC endpoints and blockchain explorers
- Other non-SDK contracts

### SDK Usage

The app uses the `shogun-contracts` SDK package for all contract interactions:

```javascript
import { ShogunSDK } from 'shogun-contracts/sdk';

// Initialize SDK
const sdk = new ShogunSDK({
  provider,
  signer,
  chainId: 84532
});

// Get contract instances
const relayRegistry = sdk.getRelayRegistry();
const storageDealRegistry = sdk.getStorageDealRegistry();

// Get contract addresses
const address = relayRegistry.getAddress();
```

### Data Flow

1. **User connects wallet** → Wallet provider (MetaMask)
2. **Network selection** → SDK initializes with correct chain ID
3. **Relay discovery** → Query `RelayRegistry` for active relays
4. **Deal creation** → User uploads file, calculates cost, creates deal on-chain
5. **Relay registration** → Selected relay registers deal and provides storage
6. **Proof verification** → Relays submit storage proofs periodically
7. **Deal management** → User can view, monitor, or grief deals

## Installation

### Prerequisites

- Node.js 18+ and npm/yarn
- A Web3 wallet (MetaMask recommended)
- Access to Base Sepolia testnet (for testing) or Base Mainnet

### Setup

```bash
# Clone the repository
git clone <repository-url>
cd shogun-deals

# Install dependencies
yarn install
# or
npm install

# Start development server
yarn dev
# or
npm run dev
```

The development server will start on `http://localhost:5174` (Vite default port).

### Build for Production

```bash
# Build optimized production bundle
yarn build
# or
npm run build

# Preview production build
yarn preview
# or
npm run preview
```

Production files are output to the `dist/` directory.

## Usage Guide

### Getting Started

1. **Open the application** in your web browser
2. **Connect your wallet** using the "Connect Wallet" button
3. **Select a network** (Base Sepolia for testing, Base Mainnet for production)
4. **Ensure you have USDC** in your wallet for payments and staking

### Creating a Storage Deal

1. **Select a Relay**:
   - Click "Browse Relays" to view available relays
   - Review relay reputation, uptime, and proof success rates
   - Select a relay from the leaderboard

2. **Upload Your File**:
   - Click "Choose File" and select the file you want to store
   - The file will be uploaded to IPFS via the selected relay
   - Wait for the IPFS CID to be generated

3. **Configure Deal Parameters**:
   - Select storage tier (Standard, Premium, or Enterprise)
   - Set storage duration (in months)
   - Review calculated cost

4. **Approve and Create**:
   - Approve USDC spending for the StorageDealRegistry contract
   - Click "Create Deal" to submit the transaction
   - Wait for on-chain confirmation

5. **Relay Registration**:
   - The selected relay will automatically register the deal on-chain
   - Monitor deal status in "My Deals"

### Managing Deals

- **View Active Deals**: Navigate to "My Deals" section to see all your storage deals
- **Monitor Status**: Check deal status, expiration dates, and proof submissions
- **Grief a Deal**: If a relay fails to provide proofs, you can grief the deal to recover your stake

### User Registration

To use advanced features like encrypted storage:

1. Click "Register User" in the user management section
2. Approve the transaction to register your wallet address
3. Your GunDB encryption keys will be derived from your wallet signature
4. You can update your keys at any time

### Stake Management

Relays can deposit stake to participate in the network:

1. Connect your relay wallet
2. Click "Deposit Stake" in the relay management section
3. Enter the amount of USDC to stake
4. Approve and confirm the transaction

**Note**: Relays cannot register as users - the contract prevents this to maintain separation of concerns.

## Pricing Tiers

The app supports three storage tiers with different replication and features:

### Standard Tier
- **Price**: $0.0001 per MB/month
- **Replication**: 1x (single copy)
- **Use Case**: Non-critical data, backups

### Premium Tier
- **Price**: $0.0002 per MB/month
- **Replication**: 3x (three copies)
- **Features**: Erasure coding
- **Use Case**: Important data requiring redundancy

### Enterprise Tier
- **Price**: $0.0005 per MB/month
- **Replication**: 5x (five copies)
- **Features**: Erasure coding, SLA guarantees
- **Use Case**: Critical business data

**Note**: Pricing is loaded dynamically from the selected relay. If a relay doesn't provide pricing, default values are used.

## Contract Addresses

### Base Sepolia (Testnet) - Chain ID: 84532

Contract addresses are managed by the SDK. To get current addresses:

```javascript
const sdk = new ShogunSDK({ provider, chainId: 84532 });
const relayRegistry = sdk.getRelayRegistry();
console.log(relayRegistry.getAddress()); // Get current address
```

**USDC Token**: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`  
**RPC Endpoint**: `https://sepolia.base.org`  
**Explorer**: `https://sepolia.basescan.org`

### Base Mainnet - Chain ID: 8453

**USDC Token**: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`  
**RPC Endpoint**: `https://mainnet.base.org`  
**Explorer**: `https://basescan.org`

**Note**: Shogun Protocol contracts on Base Mainnet are TBD (To Be Deployed).

## Development

### Project Structure

```
shogun-deals/
├── app.js              # Main application logic
├── index.html          # HTML interface
├── package.json        # Dependencies and scripts
├── vite.config.js      # Vite configuration
└── README.md           # This file
```

### Key Dependencies

- **shogun-contracts**: SDK for Shogun Protocol contract interactions
- **ethers.js**: Ethereum library for wallet and contract interactions
- **vite**: Build tool and development server

### Development Workflow

1. **Start dev server**: `yarn dev`
2. **Make changes** to `app.js` or `index.html`
3. **Test in browser** - changes hot-reload automatically
4. **Build for production**: `yarn build`

### API Integration

The app communicates with Shogun relays via REST API:

- **IPFS Upload**: `POST /api/v1/ipfs/upload`
- **Pricing Info**: `GET /api/v1/pricing`
- **Reputation Data**: `GET /api/v1/network/reputation/:host`

### Environment Configuration

The app uses hardcoded configuration in `app.js` for:
- RPC endpoints
- USDC token addresses
- Blockchain explorers

For production deployments, consider moving these to environment variables.

## Troubleshooting

### Common Issues

**"MetaMask not detected"**
- Install MetaMask browser extension
- Ensure it's enabled and unlocked

**"Wrong network"**
- Switch to the correct network (Base Sepolia or Base Mainnet)
- The app will prompt you to switch if needed

**"Insufficient USDC balance"**
- Ensure you have enough USDC for the deal cost
- For testnet, get test USDC from a faucet

**"SDK initialization failed"**
- Check that the chain ID is supported
- Verify RPC endpoint is accessible
- Ensure `shogun-contracts` package is up to date

**"Relay not responding"**
- Try selecting a different relay
- Check relay status in the leaderboard
- Verify relay endpoint is accessible

## Security Considerations

- **Private Keys**: Never share your wallet private keys. The app uses MetaMask for all signing.
- **GunDB Keys**: Encryption keys are derived from wallet signatures and stored locally.
- **Contract Interactions**: Always verify contract addresses before approving transactions.
- **Relay Selection**: Review relay reputation before creating deals with them.

## Contributing

This is part of the Shogun Protocol ecosystem. For contributions:

1. Follow the existing code style
2. Test thoroughly on testnet before mainnet
3. Update documentation for new features
4. Ensure SDK compatibility when updating contract interactions

## License

MIT License - Part of the Shogun Protocol ecosystem.

## Support

For issues, questions, or contributions:
- Check the [Shogun Protocol documentation](https://github.com/scobru/shogun)
- Open an issue in the repository
- Contact the Shogun team

---

**Built with** ❤️ **for decentralized storage**
