// Shogun Protocol - Storage Deals Standalone App
// Uses Shogun Contracts SDK for contract interactions

import { ShogunSDK } from 'shogun-contracts/sdk';

// Contract addresses - NOTE: Shogun Protocol contracts (RelayRegistry, StorageDealRegistry, etc.)
// are managed by the SDK and retrieved via sdk.getRelayRegistry().getAddress() etc.
// This CONTRACTS object is kept ONLY for:
// - USDC token addresses (not part of SDK)
// - RPC endpoints and explorers
// - Other non-SDK contracts
const CONTRACTS = {
  84532: {
    relayRegistry: '0xf5D5561C84B4Dc8676D4223AF3188d40DA42669B',
    storageDealRegistry: '0x25035812952B8a8Ca001B85f4E59919D7569566B',
    dataPostRegistry: '0x609e5De69B764e7A62aa28C97eC0162BA8Fb6aF2',
    dataSaleEscrowFactory: '0xa9a39816b4c6EF46434892AA49E760dcEBbC8d01',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
  },
  8453: {
    relayRegistry: null, // TBD
    storageDealRegistry: null, // TBD
    dataPostRegistry: null, // TBD
    dataSaleEscrowFactory: null, // TBD
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    rpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
  },
};

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
];

// Pricing tiers - will be loaded dynamically from selected relay
let relayPricing = {
  standard: {
    pricePerMBMonth: 0.0001,
    replicationFactor: 1,
  },
  premium: {
    pricePerMBMonth: 0.0002,
    replicationFactor: 3,
  },
  enterprise: {
    pricePerMBMonth: 0.0005,
    replicationFactor: 5,
  },
};

// Default pricing (fallback if relay doesn't provide pricing)
const DEFAULT_PRICING = {
  standard: {
    pricePerMBMonth: 0.0001,
    replicationFactor: 1,
  },
  premium: {
    pricePerMBMonth: 0.0002,
    replicationFactor: 3,
  },
  enterprise: {
    pricePerMBMonth: 0.0005,
    replicationFactor: 5,
  },
};

// State
let provider = null;
let signer = null;
let connectedAddress = null;
let currentChainId = 84532;
let sdk = null; // ShogunSDK instance
let relayRegistry = null; // RelayRegistry instance from SDK
let storageDealRegistry = null; // StorageDealRegistry instance from SDK
let usdc = null;
// ShogunCore instance for key derivation
let shogunCore = null;
// GunDB keypair for encryption (derived from wallet signature)
let gunKeypair = null;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadNetworkConfig();
  // Calculate price after a short delay to ensure DOM is ready
  setTimeout(() => {
    calculatePrice();
  }, 100);
  
  // Note: deposit stake button uses onclick handler directly, no need for addEventListener
  
  // Debug: Log button state after a delay
  setTimeout(() => {
    const depositStakeBtn = document.getElementById('depositStakeBtn');
    if (depositStakeBtn) {
      console.log('🔵 Deposit Stake Button state on page load:', {
        disabled: depositStakeBtn.disabled,
        exists: true,
        id: depositStakeBtn.id
      });
    } else {
      console.log('❌ Deposit Stake Button not found!');
    }
  }, 2000);
});

// Network configuration
async function loadNetworkConfig() {
  const chainId = parseInt(document.getElementById('networkSelect').value);
  currentChainId = chainId;
  
  const config = CONTRACTS[chainId];
  if (!config || !config.storageDealRegistry) {
    showMessage('createMessage', 'error', `StorageDealRegistry not deployed on chain ${chainId}`);
    return;
  }

  // Initialize provider
  provider = new ethers.JsonRpcProvider(config.rpc);
  
  // Initialize SDK
  try {
    sdk = new ShogunSDK({
      provider,
      signer: signer || undefined,
      chainId: chainId
    });
    
    relayRegistry = sdk.getRelayRegistry();
    storageDealRegistry = sdk.getStorageDealRegistry();
    
    // Get addresses from SDK
    const relayRegistryAddress = relayRegistry.getAddress();
    const storageDealRegistryAddress = storageDealRegistry.getAddress();
    
    document.getElementById('registryAddress').textContent = truncateAddress(relayRegistryAddress);
    document.getElementById('dealRegistryAddress').textContent = truncateAddress(storageDealRegistryAddress);
  } catch (error) {
    console.error('Failed to initialize SDK:', error);
    showMessage('createMessage', 'error', `Failed to initialize SDK: ${error.message}`);
    return;
  }
  
  // USDC contract (not part of SDK)
  usdc = new ethers.Contract(config.usdc, ERC20_ABI, provider);

  if (signer) {
    // Update signer if wallet is connected
    signer = await provider.getSigner();
    // Update SDK with new signer
    if (sdk) {
      sdk.setSigner(signer);
      relayRegistry = sdk.getRelayRegistry();
      storageDealRegistry = sdk.getStorageDealRegistry();
    }
    await loadMyDeals();
  }
}

async function changeNetwork() {
  await loadNetworkConfig();
  if (connectedAddress) {
    await loadMyDeals();
    await loadAvailableRelays();
  }
}

// Wallet connection
document.getElementById('connectWalletBtn').addEventListener('click', connectWallet);

async function connectWallet() {
  if (!window.ethereum) {
    showMessage('createMessage', 'error', 'MetaMask not detected. Please install MetaMask.');
    return;
  }

  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await provider.send('eth_requestAccounts', []);
    connectedAddress = accounts[0];
    signer = await provider.getSigner();
    
    // Derive GunDB keypair from wallet using ShogunCore
    // This happens asynchronously and doesn't block wallet connection
    deriveGunKeypair().catch(err => {
      console.warn('Keypair derivation failed (non-blocking):', err);
    });

    // Check network
    const network = await provider.getNetwork();
    const expectedChainId = parseInt(document.getElementById('networkSelect').value);
    
    if (Number(network.chainId) !== expectedChainId) {
      showMessage('createMessage', 'warning', `Please switch to chain ${expectedChainId}`);
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x' + expectedChainId.toString(16) }],
        });
      } catch (switchError) {
        showMessage('createMessage', 'error', `Please switch to chain ${expectedChainId} manually`);
      }
    }

    // Update SDK with signer
    if (sdk) {
      sdk.setSigner(signer);
      relayRegistry = sdk.getRelayRegistry();
      storageDealRegistry = sdk.getStorageDealRegistry();
    }
    
    // Update USDC contract with signer
    const config = CONTRACTS[currentChainId];
    usdc = new ethers.Contract(config.usdc, ERC20_ABI, signer);

    document.getElementById('walletSection').style.display = 'none';
    document.getElementById('connectedSection').style.display = 'block';
    document.getElementById('walletAddress').textContent = `${connectedAddress.slice(0, 6)}...${connectedAddress.slice(-4)}`;
    
    await Promise.all([
      loadMyDeals(),
      loadAvailableRelays(),
      loadSubscriptionRelays()
    ]);
  } catch (error) {
    console.error('Wallet connection error:', error);
    showMessage('createMessage', 'error', 'Failed to connect wallet: ' + error.message);
  }
}

function disconnectWallet() {
  connectedAddress = null;
  provider = null;
  signer = null;
  
  document.getElementById('walletSection').style.display = 'block';
  document.getElementById('connectedSection').style.display = 'none';
}

// Tab switching
function showTab(tabName, event) {
  document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
  document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
  
  document.getElementById(`tab-${tabName}`).style.display = 'block';
  
  // Find and activate the clicked button
  if (event && event.target) {
    event.target.classList.add('active');
  } else {
    // Fallback: find button by data attribute or text content
    const buttons = document.querySelectorAll('.tab-button');
    buttons.forEach(btn => {
      const onclickAttr = btn.getAttribute('onclick');
      if (onclickAttr && onclickAttr.includes(`'${tabName}'`)) {
        btn.classList.add('active');
      }
    });
  }
  
  if (tabName === 'mydeals' && connectedAddress) {
    loadMyDeals();
  } else if (tabName === 'register' && connectedAddress) {
    loadRegistrationStatus();
  } else if (tabName === 'subscriptions' && connectedAddress) {
    loadSubscriptionRelays();
  }
}

// Price calculation - uses pricing from selected relay
function calculatePrice() {
  const sizeMB = parseFloat(document.getElementById('calcSizeMB')?.value || document.getElementById('dealSizeMB')?.value) || 0;
  const duration = parseInt(document.getElementById('calcDuration')?.value || document.getElementById('dealDuration')?.value) || 0;
  const tier = document.getElementById('calcTier')?.value || document.getElementById('dealTier')?.value || 'premium';

  if (sizeMB <= 0 || duration <= 0) {
    if (document.getElementById('calculatedPrice')) {
      document.getElementById('calculatedPrice').textContent = '--';
      document.getElementById('priceBreakdown').textContent = 'Enter valid size and duration';
    }
    return null;
  }

  // Use pricing from selected relay (or default if not loaded)
  const pricing = relayPricing[tier] || DEFAULT_PRICING[tier];
  if (!pricing) {
    console.warn(`Pricing not found for tier: ${tier}, using default`);
    return null;
  }

  const months = duration / 30;
  const basePrice = sizeMB * months * pricing.pricePerMBMonth;
  const totalPrice = basePrice * pricing.replicationFactor;

  if (document.getElementById('calculatedPrice')) {
    document.getElementById('calculatedPrice').textContent = `$${totalPrice.toFixed(6)} USDC`;
    document.getElementById('priceBreakdown').textContent = 
      `${pricing.replicationFactor}x replication @ ${pricing.pricePerMBMonth} USDC/MB/month`;
  }

  // Update deal preview
  if (document.getElementById('dealPrice')) {
    document.getElementById('dealPrice').textContent = `$${totalPrice.toFixed(6)} USDC`;
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + duration);
    document.getElementById('dealExpiry').textContent = expiry.toLocaleDateString();
    document.getElementById('dealPreview').style.display = 'block';
  }

  return totalPrice;
}

// Load available relays with reputation data
async function loadAvailableRelays() {
  if (!relayRegistry) return;

  const relaySelect = document.getElementById('dealRelay');
  relaySelect.innerHTML = '<option value="">Loading relays...</option>';
  relaySelect.disabled = true;

  try {
    const addresses = await relayRegistry.getActiveRelays();
    
    if (addresses.length === 0) {
      relaySelect.innerHTML = '<option value="">No relays available</option>';
      showMessage('createMessage', 'warning', 'No active relays found in registry');
      return;
    }

    // Load reputation data from all relays (try to get from first relay's endpoint)
    // We'll try to get reputation from any relay that has an endpoint
    let reputationMap = new Map();
    
    // Try to get reputation data from the first relay that has an endpoint
    for (const addr of addresses) {
      try {
        const info = await relayRegistry.getRelayInfo(addr);
        const endpoint = info.endpoint || '';
        if (endpoint) {
          try {
            // Try to fetch reputation leaderboard from this relay
            const repResponse = await fetch(`${endpoint}/api/v1/network/reputation?limit=50`);
            if (repResponse.ok) {
              const repData = await repResponse.json();
              if (repData.success && repData.leaderboard) {
                // Map relay addresses to reputation data
                for (const relay of repData.leaderboard) {
                  // Normalize host - remove protocol to match by hostname
                  let normalizedHost = relay.host;
                  try {
                    if (relay.host.includes('://')) {
                      const url = new URL(relay.host);
                      normalizedHost = url.hostname;
                    }
                  } catch (e) {
                    // If URL parsing fails, use as-is
                    normalizedHost = relay.host;
                  }
                  
                  // If host already exists, prefer entry with real data (expectedPulses > 0)
                  const existing = reputationMap.get(normalizedHost);
                  if (existing) {
                    // Prefer entry with actual data over one with all zeros
                    if (relay.expectedPulses > 0 && existing.expectedPulses === 0) {
                      reputationMap.set(normalizedHost, relay);
                    }
                  } else {
                    reputationMap.set(normalizedHost, relay);
                  }
                }
              }
            }
          } catch (repError) {
            console.warn(`Could not load reputation from ${endpoint}:`, repError);
          }
          // Only need to try once - reputation is synced across network
          break;
        }
      } catch (e) {
        console.warn(`Error checking relay ${addr} for reputation endpoint:`, e);
      }
    }

    relaySelect.innerHTML = '<option value="">Select a relay...</option>';
    
    for (const addr of addresses) {
      try {
        const info = await relayRegistry.getRelayInfo(addr);
        // Convert bytes to string if needed
        const endpoint = info.endpoint || '';
        const option = document.createElement('option');
        
        // Try to find reputation data for this relay
        // Match by endpoint hostname or try to get from relay directly
        let reputation = null;
        if (endpoint) {
          try {
            const url = new URL(endpoint);
            const host = url.hostname;
            const rawReputation = reputationMap.get(host);
            
            // Convert raw reputation from map to structured format
            if (rawReputation) {
              // Calculate uptimePercent
              let uptimePercent = rawReputation.uptimePercent;
              if (uptimePercent === null || uptimePercent === undefined) {
                if (rawReputation.expectedPulses > 0 && rawReputation.receivedPulses !== undefined) {
                  uptimePercent = (rawReputation.receivedPulses / rawReputation.expectedPulses) * 100;
                } else {
                  uptimePercent = null;
                }
              }
              
              // Calculate proofSuccessRate
              let proofSuccessRate = rawReputation.proofSuccessRate;
              if (proofSuccessRate === null || proofSuccessRate === undefined) {
                if (rawReputation.proofsTotal > 0 && rawReputation.proofsSuccessful !== undefined) {
                  proofSuccessRate = (rawReputation.proofsSuccessful / rawReputation.proofsTotal) * 100;
                } else {
                  proofSuccessRate = null;
                }
              }
              
              reputation = {
                host: host,
                reputation: {
                  score: rawReputation.calculatedScore?.total || rawReputation.score || 50,
                  tier: rawReputation.calculatedScore?.tier || rawReputation.tier || 'average',
                },
                metrics: {
                  uptimePercent: uptimePercent,
                  proofSuccessRate: proofSuccessRate,
                },
              };
            }
            
            // If not found in map, try to get directly from relay
            if (!reputation) {
              try {
                const repResponse = await fetch(`${endpoint}/api/v1/network/reputation/${host}`);
                if (repResponse.ok) {
                  const repData = await repResponse.json();
                  if (repData.success && repData.reputation) {
                    reputation = {
                      host: host,
                      reputation: {
                        score: repData.reputation.calculatedScore?.total || 50,
                        tier: repData.reputation.calculatedScore?.tier || 'average',
                      },
                      metrics: {
                        uptimePercent: repData.reputation.uptimePercent || 0,
                        proofSuccessRate: repData.reputation.proofsTotal > 0
                          ? (repData.reputation.proofsSuccessful / repData.reputation.proofsTotal) * 100
                          : null,
                      },
                    };
                  }
                }
              } catch (e) {
                // Reputation not available for this relay
              }
            }
          } catch (e) {
            // Invalid endpoint URL
          }
        }
        
        const stake = ethers.formatUnits(info.stakedAmount, 6);
        let displayText = `${addr.slice(0, 6)}...${addr.slice(-4)} - ${stake} USDC`;
        
        // Add reputation badge if available
        if (reputation && reputation.reputation) {
          const score = reputation.reputation.score;
          const tier = reputation.reputation.tier;
          const tierEmoji = tier === 'excellent' ? '⭐' : tier === 'good' ? '✓' : tier === 'average' ? '○' : '⚠';
          displayText += ` [${tierEmoji} ${score.toFixed(0)}]`;
        }
        
        option.value = addr;
        option.textContent = displayText;
        option.dataset.stake = stake;
        option.dataset.endpoint = endpoint;
        if (reputation) {
          option.dataset.reputation = JSON.stringify(reputation);
        }
        relaySelect.appendChild(option);
      } catch (e) {
        console.error(`Error loading relay ${addr}:`, e);
      }
    }
    
    relaySelect.disabled = false;
    relaySelect.addEventListener('change', () => {
      updateRelayInfo().catch(err => {
        console.error('Error updating relay info:', err);
      });
      // Recalculate price when relay changes
      calculatePrice();
    });
    
    // If there's already a selected relay, update info and calculate price
    if (relaySelect.value) {
      updateRelayInfo().catch(err => {
        console.error('Error updating relay info:', err);
      });
      calculatePrice();
    }
  } catch (error) {
    console.error('Error loading relays:', error);
    relaySelect.innerHTML = '<option value="">Error loading relays</option>';
    showMessage('createMessage', 'error', 'Failed to load relays: ' + error.message);
  } finally {
    relaySelect.disabled = false;
  }
}

async function updateRelayInfo() {
  const relaySelect = document.getElementById('dealRelay');
  const selectedOption = relaySelect.options[relaySelect.selectedIndex];
  const relayInfoDiv = document.getElementById('relayInfo');
  
  if (selectedOption && selectedOption.value) {
    document.getElementById('relayStake').textContent = selectedOption.dataset.stake + ' USDC';
    const endpointLink = document.getElementById('relayEndpoint');
    const relayEndpoint = selectedOption.dataset.endpoint;
    endpointLink.href = relayEndpoint;
    endpointLink.textContent = relayEndpoint || 'N/A';
    
    // Parse reputation data if available
    let reputation = null;
    if (selectedOption.dataset.reputation) {
      try {
        reputation = JSON.parse(selectedOption.dataset.reputation);
      } catch (e) {
        console.warn('Failed to parse reputation data:', e);
      }
    }
    
    // If no reputation in dataset, try to fetch it
    if (!reputation && relayEndpoint) {
      try {
        const url = new URL(relayEndpoint);
        const host = url.hostname;
        const repResponse = await fetch(`${relayEndpoint}/api/v1/network/reputation/${host}`);
        if (repResponse.ok) {
          const repData = await repResponse.json();
          if (repData.success && repData.reputation) {
            // Calculate uptimePercent if not present
            let uptimePercent = repData.reputation.uptimePercent;
            if (uptimePercent === null || uptimePercent === undefined) {
              if (repData.reputation.expectedPulses > 0 && repData.reputation.receivedPulses !== undefined) {
                uptimePercent = (repData.reputation.receivedPulses / repData.reputation.expectedPulses) * 100;
              } else {
                uptimePercent = null;
              }
            }
            
            // Calculate proofSuccessRate if not present
            let proofSuccessRate = repData.reputation.proofSuccessRate;
            if (proofSuccessRate === null || proofSuccessRate === undefined) {
              if (repData.reputation.proofsTotal > 0 && repData.reputation.proofsSuccessful !== undefined) {
                proofSuccessRate = (repData.reputation.proofsSuccessful / repData.reputation.proofsTotal) * 100;
              } else {
                proofSuccessRate = null;
              }
            }
            
            reputation = {
              host: host,
              reputation: {
                score: repData.reputation.calculatedScore?.total || 50,
                tier: repData.reputation.calculatedScore?.tier || 'average',
                recommended: (repData.reputation.calculatedScore?.total || 0) >= 75,
              },
              metrics: {
                uptimePercent: uptimePercent,
                proofSuccessRate: proofSuccessRate,
              },
            };
          }
        } else {
          console.warn(`Failed to fetch reputation for ${host}: ${repResponse.status} ${repResponse.statusText}`);
        }
      } catch (e) {
        console.warn('Could not fetch reputation:', e);
      }
    }
    
    // Update reputation display
    let reputationSection = document.getElementById('relayReputation');
    if (reputation && reputation.reputation) {
      const rep = reputation.reputation;
      const metrics = reputation.metrics || {};
      
      // Create or update reputation section
      if (!reputationSection) {
        // Create reputation section HTML
        const repHTML = `
          <div id="relayReputation" class="mt-2 p-2 bg-[#1A1A1A] rounded border border-[#404040]">
            <div class="flex justify-between items-center mb-2">
              <span class="text-[#A0A0A0] text-xs font-medium">Reputation Score:</span>
              <span class="text-[#42A5F5] font-semibold text-sm" id="relayReputationScore">--</span>
            </div>
            <div class="flex justify-between items-center mb-1">
              <span class="text-[#606060] text-xs">Tier:</span>
              <span class="text-[#A0A0A0] text-xs capitalize" id="relayReputationTier">--</span>
            </div>
            <div class="flex justify-between items-center mb-1">
              <span class="text-[#606060] text-xs">Uptime:</span>
              <span class="text-[#A0A0A0] text-xs" id="relayReputationUptime">--</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-[#606060] text-xs">Proof Success:</span>
              <span class="text-[#A0A0A0] text-xs" id="relayReputationProof">--</span>
            </div>
            <div id="relayReputationRecommended" class="mt-1 text-[#4CAF50] text-xs" style="display: none;">✓ Recommended Relay</div>
          </div>
        `;
        relayInfoDiv.insertAdjacentHTML('beforeend', repHTML);
        reputationSection = document.getElementById('relayReputation');
      }
      
      // Show reputation section
      reputationSection.style.display = 'block';
      
      // Update reputation values
      const score = rep.score || 0;
      const tier = rep.tier || 'unknown';
      const uptime = metrics.uptimePercent !== null && metrics.uptimePercent !== undefined 
        ? `${metrics.uptimePercent.toFixed(1)}%` 
        : 'N/A';
      const proofRate = metrics.proofSuccessRate !== null && metrics.proofSuccessRate !== undefined
        ? `${metrics.proofSuccessRate.toFixed(1)}%`
        : 'N/A';
      
      document.getElementById('relayReputationScore').textContent = `${score.toFixed(1)}/100`;
      document.getElementById('relayReputationTier').textContent = tier;
      document.getElementById('relayReputationUptime').textContent = uptime;
      document.getElementById('relayReputationProof').textContent = proofRate;
      
      // Show/hide recommended badge
      const recommendedEl = document.getElementById('relayReputationRecommended');
      if (rep.recommended || score >= 75) {
        recommendedEl.style.display = 'block';
      } else {
        recommendedEl.style.display = 'none';
      }
      
      // Color code score
      const scoreEl = document.getElementById('relayReputationScore');
      if (score >= 75) {
        scoreEl.className = 'text-[#4CAF50] font-semibold text-sm';
      } else if (score >= 50) {
        scoreEl.className = 'text-[#FF9800] font-semibold text-sm';
      } else {
        scoreEl.className = 'text-[#F44336] font-semibold text-sm';
      }
    } else {
      // Hide reputation section if no data
      if (reputationSection) {
        reputationSection.style.display = 'none';
      }
    }
    
    relayInfoDiv.style.display = 'block';
    
    // Load pricing from selected relay
    if (relayEndpoint) {
      await loadRelayPricing(relayEndpoint);
      // Recalculate price with new pricing
      calculatePrice();
    }
  } else {
    relayInfoDiv.style.display = 'none';
    // Reset to default pricing
    relayPricing = { ...DEFAULT_PRICING };
    calculatePrice();
  }
}

// Show relay leaderboard modal
async function showRelayLeaderboard() {
  if (!relayRegistry) {
    showMessage('createMessage', 'error', 'Relay registry not initialized');
    return;
  }

  // Create modal if it doesn't exist
  let modal = document.getElementById('relayLeaderboardModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'relayLeaderboardModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
    modal.innerHTML = `
      <div class="bg-[#282828] border border-[#404040] rounded-2xl p-6 max-w-4xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div class="flex justify-between items-center mb-4">
          <h3 class="text-xl font-bold text-[#FFFFFF]">Relay Leaderboard</h3>
          <button onclick="closeRelayLeaderboard()" class="text-[#A0A0A0] hover:text-[#FFFFFF] text-2xl">&times;</button>
        </div>
        <div id="leaderboardContent" class="space-y-3">
          <div class="text-center text-[#A0A0A0] py-8">
            <div class="loading-spinner mb-4"></div>
            <p>Loading relay leaderboard...</p>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  modal.style.display = 'flex';
  const content = document.getElementById('leaderboardContent');
  content.innerHTML = '<div class="text-center text-[#A0A0A0] py-8"><div class="loading-spinner mb-4"></div><p>Loading relay leaderboard...</p></div>';

  try {
    // Get all active relays
    const addresses = await relayRegistry.getActiveRelays();
    
    if (addresses.length === 0) {
      content.innerHTML = '<div class="text-center text-[#A0A0A0] py-8">No active relays found</div>';
      return;
    }

    // Try to get reputation data from any relay endpoint
    let reputationMap = new Map();
    let reputationEndpoint = null;

    for (const addr of addresses) {
      try {
        const info = await relayRegistry.getRelayInfo(addr);
        const endpoint = info.endpoint || '';
        if (endpoint) {
          try {
            const repResponse = await fetch(`${endpoint}/api/v1/network/reputation?limit=50`);
            if (repResponse.ok) {
              const repData = await repResponse.json();
              if (repData.success && repData.leaderboard) {
                for (const relay of repData.leaderboard) {
                  // Normalize host - remove protocol to match by hostname
                  let normalizedHost = relay.host;
                  try {
                    if (relay.host.includes('://')) {
                      const url = new URL(relay.host);
                      normalizedHost = url.hostname;
                    }
                  } catch (e) {
                    // If URL parsing fails, use as-is
                    normalizedHost = relay.host;
                  }
                  
                  // If host already exists, prefer entry with real data (expectedPulses > 0)
                  const existing = reputationMap.get(normalizedHost);
                  if (existing) {
                    // Prefer entry with actual data over one with all zeros
                    if (relay.expectedPulses > 0 && existing.expectedPulses === 0) {
                      reputationMap.set(normalizedHost, relay);
                    }
                  } else {
                    reputationMap.set(normalizedHost, relay);
                  }
                }
                reputationEndpoint = endpoint;
                break; // Got reputation data, no need to try more
              }
            }
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        continue;
      }
    }

    // Build leaderboard HTML
    const relays = [];
    for (const addr of addresses) {
      try {
        const info = await relayRegistry.getRelayInfo(addr);
        const endpoint = info.endpoint || '';
        let reputation = null;
        
        if (endpoint) {
          try {
            const url = new URL(endpoint);
            const host = url.hostname;
            const rawReputation = reputationMap.get(host);
            
            // Convert raw reputation from map to structured format
            if (rawReputation) {
              // Calculate uptimePercent
              let uptimePercent = rawReputation.uptimePercent;
              if (uptimePercent === null || uptimePercent === undefined) {
                if (rawReputation.expectedPulses > 0 && rawReputation.receivedPulses !== undefined) {
                  uptimePercent = (rawReputation.receivedPulses / rawReputation.expectedPulses) * 100;
                } else {
                  uptimePercent = null;
                }
              }
              
              // Calculate proofSuccessRate
              let proofSuccessRate = rawReputation.proofSuccessRate;
              if (proofSuccessRate === null || proofSuccessRate === undefined) {
                if (rawReputation.proofsTotal > 0 && rawReputation.proofsSuccessful !== undefined) {
                  proofSuccessRate = (rawReputation.proofsSuccessful / rawReputation.proofsTotal) * 100;
                } else {
                  proofSuccessRate = null;
                }
              }
              
              reputation = {
                host: host,
                reputation: {
                  score: rawReputation.calculatedScore?.total || rawReputation.score || 50,
                  tier: rawReputation.calculatedScore?.tier || rawReputation.tier || 'average',
                },
                metrics: {
                  uptimePercent: uptimePercent,
                  proofSuccessRate: proofSuccessRate,
                },
              };
            }
            
            // If not in map, try direct fetch
            if (!reputation && reputationEndpoint) {
              try {
                const repResponse = await fetch(`${reputationEndpoint}/api/v1/network/reputation/${host}`);
                if (repResponse.ok) {
                  const repData = await repResponse.json();
                  if (repData.success && repData.reputation) {
                    // Calculate uptimePercent if not present
                    let uptimePercent = repData.reputation.uptimePercent;
                    if (uptimePercent === null || uptimePercent === undefined) {
                      if (repData.reputation.expectedPulses > 0 && repData.reputation.receivedPulses !== undefined) {
                        uptimePercent = (repData.reputation.receivedPulses / repData.reputation.expectedPulses) * 100;
                      } else {
                        uptimePercent = null;
                      }
                    }
                    
                    // Calculate proofSuccessRate if not present
                    let proofSuccessRate = repData.reputation.proofSuccessRate;
                    if (proofSuccessRate === null || proofSuccessRate === undefined) {
                      if (repData.reputation.proofsTotal > 0 && repData.reputation.proofsSuccessful !== undefined) {
                        proofSuccessRate = (repData.reputation.proofsSuccessful / repData.reputation.proofsTotal) * 100;
                      } else {
                        proofSuccessRate = null;
                      }
                    }
                    
                    reputation = {
                      host: host,
                      reputation: {
                        score: repData.reputation.calculatedScore?.total || 50,
                        tier: repData.reputation.calculatedScore?.tier || 'average',
                      },
                      metrics: {
                        uptimePercent: uptimePercent,
                        proofSuccessRate: proofSuccessRate,
                      },
                    };
                  }
                } else {
                  console.warn(`Failed to fetch reputation for ${host}: ${repResponse.status} ${repResponse.statusText}`);
                }
              } catch (e) {
                console.warn(`Error fetching reputation for ${host}:`, e);
              }
            }
          } catch (e) {
            // Invalid endpoint
          }
        }

        const score = reputation?.reputation?.score || 50;
        relays.push({
          address: addr,
          endpoint: endpoint,
          stake: ethers.formatUnits(info.stakedAmount, 6),
          reputation: reputation,
          score: score,
        });
      } catch (e) {
        console.error(`Error loading relay ${addr}:`, e);
      }
    }

    // Sort by reputation score
    relays.sort((a, b) => b.score - a.score);

    // Generate HTML
    content.innerHTML = relays.map((relay, index) => {
      const rep = relay.reputation?.reputation;
      const metrics = relay.reputation?.metrics || {};
      const score = rep?.score || 50;
      const tier = rep?.tier || 'unknown';
      const uptime = metrics.uptimePercent !== null && metrics.uptimePercent !== undefined 
        ? `${metrics.uptimePercent.toFixed(1)}%` 
        : 'N/A';
      const proofRate = metrics.proofSuccessRate !== null && metrics.proofSuccessRate !== undefined
        ? `${metrics.proofSuccessRate.toFixed(1)}%`
        : 'N/A';
      
      const scoreColor = score >= 75 ? '#4CAF50' : score >= 50 ? '#FF9800' : '#F44336';
      const rankEmoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;

      return `
        <div class="p-4 bg-[#1A1A1A] rounded-lg border border-[#404040] hover:border-[#42A5F5] transition-colors cursor-pointer" 
             onclick="selectRelayFromLeaderboard('${relay.address}')">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-3">
              <span class="text-[#42A5F5] font-bold">${rankEmoji}</span>
              <div>
                <div class="text-[#FFFFFF] font-medium">${relay.address.slice(0, 6)}...${relay.address.slice(-4)}</div>
                <div class="text-[#606060] text-xs">${relay.endpoint || 'No endpoint'}</div>
              </div>
            </div>
            <div class="text-right">
              <div class="text-[${scoreColor}] font-bold text-lg">${score.toFixed(1)}</div>
              <div class="text-[#606060] text-xs capitalize">${tier}</div>
            </div>
          </div>
          <div class="grid grid-cols-3 gap-4 mt-3 text-xs">
            <div>
              <div class="text-[#606060]">Stake</div>
              <div class="text-[#A0A0A0]">${relay.stake} USDC</div>
            </div>
            <div>
              <div class="text-[#606060]">Uptime</div>
              <div class="text-[#A0A0A0]">${uptime}</div>
            </div>
            <div>
              <div class="text-[#606060]">Proof Success</div>
              <div class="text-[#A0A0A0]">${proofRate}</div>
            </div>
          </div>
          ${score >= 75 ? '<div class="mt-2 text-[#4CAF50] text-xs">✓ Recommended</div>' : ''}
        </div>
      `;
    }).join('');

    if (relays.length === 0) {
      content.innerHTML = '<div class="text-center text-[#A0A0A0] py-8">No relays available</div>';
    }
  } catch (error) {
    console.error('Error loading leaderboard:', error);
    content.innerHTML = `<div class="text-center text-[#F44336] py-8">Error loading leaderboard: ${error.message}</div>`;
  }
}

function closeRelayLeaderboard() {
  const modal = document.getElementById('relayLeaderboardModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

function selectRelayFromLeaderboard(relayAddress) {
  const relaySelect = document.getElementById('dealRelay');
  relaySelect.value = relayAddress;
  updateRelayInfo().catch(err => console.error('Error updating relay info:', err));
  closeRelayLeaderboard();
  showMessage('createMessage', 'success', 'Relay selected from leaderboard');
}

/**
 * Load pricing configuration from selected relay
 */
async function loadRelayPricing(relayEndpoint) {
  try {
    const response = await fetch(`${relayEndpoint}/api/v1/deals/pricing`);
    if (!response.ok) {
      throw new Error(`Failed to fetch pricing: ${response.status}`);
    }
    
    const data = await response.json();
    if (data.success && data.tiers) {
      // Update relay pricing with data from relay
      relayPricing = {
        standard: {
          pricePerMBMonth: data.tiers.standard?.pricePerMBMonth || DEFAULT_PRICING.standard.pricePerMBMonth,
          replicationFactor: data.tiers.standard?.replicationFactor || 1,
        },
        premium: {
          pricePerMBMonth: data.tiers.premium?.pricePerMBMonth || DEFAULT_PRICING.premium.pricePerMBMonth,
          replicationFactor: data.tiers.premium?.replicationFactor || 3,
        },
        enterprise: {
          pricePerMBMonth: data.tiers.enterprise?.pricePerMBMonth || DEFAULT_PRICING.enterprise.pricePerMBMonth,
          replicationFactor: data.tiers.enterprise?.replicationFactor || 5,
        },
      };
      
      console.log('✅ Loaded pricing from relay:', relayPricing);
    } else {
      console.warn('⚠️ Relay pricing response invalid, using defaults');
      relayPricing = { ...DEFAULT_PRICING };
    }
  } catch (error) {
    console.error('❌ Failed to load relay pricing:', error);
    // Use default pricing on error
    relayPricing = { ...DEFAULT_PRICING };
    showMessage('createMessage', 'warning', 
      'Could not load pricing from relay. Using default pricing. ' + error.message
    );
  }
}

// Create deal on-chain
// Validation helper functions
function validateCID(cid) {
  if (!cid || typeof cid !== 'string') {
    return { valid: false, error: 'CID is required' };
  }
  // Basic CID validation: should start with Qm (v0) or baf* (v1)
  const trimmed = cid.trim();
  if (trimmed.length < 10) {
    return { valid: false, error: 'CID appears to be invalid (too short)' };
  }
  // Check for common CID patterns (Qm for v0, or baf* for v1)
  if (!trimmed.match(/^(Qm|baf[a-z0-9]+)/i)) {
    return { valid: false, error: 'CID format appears invalid. Should start with Qm (v0) or baf* (v1)' };
  }
  return { valid: true };
}

function validateNumericInput(value, min, max, fieldName) {
  const num = parseFloat(value);
  if (isNaN(num)) {
    return { valid: false, error: `${fieldName} must be a valid number` };
  }
  if (num < min) {
    return { valid: false, error: `${fieldName} must be at least ${min}` };
  }
  if (max && num > max) {
    return { valid: false, error: `${fieldName} must be at most ${max}` };
  }
  return { valid: true, value: num };
}

async function createDeal() {
  if (!connectedAddress || !signer || !storageDealRegistry) {
    showMessage('createMessage', 'error', 'Please connect your wallet first');
    return;
  }

  // Get and validate inputs
  const cid = document.getElementById('dealCid').value.trim();
  const sizeMBInput = document.getElementById('dealSizeMB').value;
  const durationInput = document.getElementById('dealDuration').value;
  const tier = document.getElementById('dealTier').value;
  const relayAddress = document.getElementById('dealRelay').value;
  const clientStakeInput = document.getElementById('clientStake').value || '0';

  // Validate CID
  const cidValidation = validateCID(cid);
  if (!cidValidation.valid) {
    showMessage('createMessage', 'error', cidValidation.error);
    return;
  }

  // Validate size (1 MB to 100 GB)
  const sizeValidation = validateNumericInput(sizeMBInput, 1, 100000, 'File size');
  if (!sizeValidation.valid) {
    showMessage('createMessage', 'error', sizeValidation.error);
    return;
  }
  const sizeMB = sizeValidation.value;

  // Validate duration (7 to 1825 days = 5 years)
  const durationValidation = validateNumericInput(durationInput, 7, 1825, 'Duration');
  if (!durationValidation.valid) {
    showMessage('createMessage', 'error', durationValidation.error);
    return;
  }
  const duration = Math.floor(durationValidation.value);

  // Validate client stake (0 to reasonable max, e.g., 10000 USDC)
  const stakeValidation = validateNumericInput(clientStakeInput, 0, 10000, 'Client stake');
  if (!stakeValidation.valid) {
    showMessage('createMessage', 'error', stakeValidation.error);
    return;
  }
  const clientStake = stakeValidation.value;

  // Validate relay selection
  if (!relayAddress) {
    showMessage('createMessage', 'error', 'Please select a relay provider');
    return;
  }

  // Validate tier
  if (!['standard', 'premium', 'enterprise'].includes(tier)) {
    showMessage('createMessage', 'error', 'Invalid tier selected');
    return;
  }

  try {
    document.getElementById('createDealBtn').disabled = true;
    document.getElementById('createDealBtn').innerHTML = '<div class="loading-spinner mr-2"></div> Creating...';

    // Calculate price
    const price = calculatePrice();
    if (!price) {
      throw new Error('Invalid price calculation');
    }

    // Get relay endpoint from selected option
    const relaySelect = document.getElementById('dealRelay');
    const selectedOption = relaySelect.options[relaySelect.selectedIndex];
    const relayEndpoint = selectedOption.dataset.endpoint;
    
    if (!relayEndpoint) {
      throw new Error('Relay endpoint not found. Please select a valid relay.');
    }

    // Step 1: Create deal via relay API
    showMessage('createMessage', 'info', 'Creating deal with relay...');
    
    let createResponse;
    try {
      createResponse = await fetch(`${relayEndpoint}/api/v1/deals/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cid,
          clientAddress: connectedAddress,
          sizeMB,
          durationDays: duration,
          tier,
          relayAddress: relayAddress, // The on-chain relay address
        }),
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });
    } catch (fetchError) {
      if (fetchError.name === 'AbortError') {
        throw new Error('Request timed out. The relay may be slow or unavailable. Please try again.');
      }
      throw Object.assign(new Error('Network error connecting to relay'), { code: 'NETWORK_ERROR', originalError: fetchError });
    }

    if (!createResponse.ok) {
      let errorData;
      try {
        errorData = await createResponse.json();
      } catch {
        throw new Error(`Relay returned error status ${createResponse.status}: ${createResponse.statusText}`);
      }
      throw new Error(errorData.error || `Failed to create deal with relay (status ${createResponse.status})`);
    }

    const createData = await createResponse.json();
    if (!createData.success) {
      throw new Error(createData.error || 'Failed to create deal');
    }

    const dealId = createData.deal.id;
    const paymentInfo = createData.paymentRequired;

    // Step 2: Approve StorageDealRegistry to spend USDC
    // The contract will transfer funds from client to relay when relay calls registerDeal
    // This follows the same pattern as DataSaleEscrow where buyer approves escrow contract
    // Use address from SDK instead of hardcoded CONTRACTS
    const storageDealRegistryAddress = storageDealRegistry.getAddress();
    const amountToApprove = BigInt(paymentInfo.amountAtomic);
    
    // Check balance
    const balance = await usdc.balanceOf(connectedAddress);
    if (balance < amountToApprove) {
      throw new Error(`Insufficient USDC balance. Need: ${ethers.formatUnits(amountToApprove, 6)}, Have: ${ethers.formatUnits(balance, 6)}`);
    }

    // Check and approve if needed
    const allowance = await usdc.allowance(connectedAddress, storageDealRegistryAddress);
    if (allowance < amountToApprove) {
      showMessage('createMessage', 'info', 'Approving USDC for StorageDealRegistry contract...');
      const approveTx = await usdc.approve(storageDealRegistryAddress, amountToApprove * 2n); // Approve 2x for safety
      await approveTx.wait();
      showMessage('createMessage', 'success', 'USDC approved. Relay will register deal on-chain.');
    }

    // Step 3: Notify relay to activate deal
    // Relay will call registerDeal() which uses safeTransferFrom to pull payment from client
    showMessage('createMessage', 'info', 'Notifying relay to register deal on-chain...');
    
    let activateResponse;
    try {
      activateResponse = await fetch(`${relayEndpoint}/api/v1/deals/${dealId}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No paymentTxHash needed - payment is handled via approval + registerDeal
        }),
        signal: AbortSignal.timeout(60000), // 60 second timeout for on-chain operations
      });
    } catch (fetchError) {
      if (fetchError.name === 'AbortError') {
        throw new Error('Activation request timed out. The deal may still be processing. Please check your deals list.');
      }
      throw Object.assign(new Error('Network error during deal activation'), { code: 'NETWORK_ERROR', originalError: fetchError });
    }

    if (!activateResponse.ok) {
      let errorData;
      try {
        errorData = await activateResponse.json();
      } catch {
        throw new Error(`Relay returned error status ${activateResponse.status}: ${activateResponse.statusText}`);
      }
      throw new Error(errorData.error || `Failed to activate deal (status ${activateResponse.status})`);
    }

    const activateData = await activateResponse.json();
    if (!activateData.success) {
      throw new Error(activateData.error || 'Failed to activate deal');
    }

    showMessage('createMessage', 'success', 
      `Deal activated! Deal ID: ${dealId}, On-chain TX: ${activateData.onChainTx || 'pending'}`
    );

    // Reload deals
    await loadMyDeals();

  } catch (error) {
    console.error('Create deal error:', error);
    
    // Provide more specific error messages
    let errorMessage = 'Error creating deal: ';
    if (error.message) {
      errorMessage += error.message;
    } else if (error.reason) {
      errorMessage += error.reason;
    } else if (typeof error === 'string') {
      errorMessage += error;
    } else {
      errorMessage += 'Unknown error occurred';
    }

    // Check for common error types
    if (error.code === 'NETWORK_ERROR' || error.message?.includes('fetch')) {
      errorMessage = 'Network error: Could not connect to relay. Please check your connection and try again.';
    } else if (error.code === 'ACTION_REJECTED' || error.message?.includes('User rejected')) {
      errorMessage = 'Transaction rejected by user';
    } else if (error.code === 'INSUFFICIENT_FUNDS' || error.message?.includes('insufficient funds')) {
      errorMessage = 'Insufficient funds. Please ensure you have enough USDC for the deal and gas fees.';
    } else if (error.message?.includes('timeout')) {
      errorMessage = 'Request timed out. Please try again.';
    }

    showMessage('createMessage', 'error', errorMessage);
  } finally {
    document.getElementById('createDealBtn').disabled = false;
    document.getElementById('createDealBtn').innerHTML = 'Create Deal On-Chain';
  }
}

// Load my deals
async function loadMyDeals() {
  if (!connectedAddress || !storageDealRegistry) return;

  try {
    const dealIds = await storageDealRegistry.getClientDeals(connectedAddress);
    
    // Update stats
    let total = dealIds.length;
    let active = 0;
    let totalSizeMB = 0;
    let totalSpent = 0;

    const dealsList = document.getElementById('dealsList');
    
    if (dealIds.length === 0) {
      dealsList.innerHTML = `
        <div class="text-center text-[#A0A0A0] py-8">
          <p>No deals found</p>
          <p class="text-sm mt-2">Create your first storage deal to get started</p>
        </div>
      `;
      updateStats(total, active, totalSizeMB, totalSpent);
      return;
    }

    // Load ALL deals first (for stats calculation)
    const allDeals = [];
    for (const dealId of dealIds) {
      try {
        const deal = await storageDealRegistry.getDeal(dealId);
        const isActive = deal.active && Number(deal.expiresAt) * 1000 > Date.now();
        
        // Update stats for all deals
        if (isActive) active++;
        totalSizeMB += Number(deal.sizeMB);
        totalSpent += parseFloat(ethers.formatUnits(deal.priceUSDC, 6));
        
        // Ensure dealId is a complete bytes32 hex string
        let dealIdHex = deal.dealId;
        if (typeof dealIdHex !== 'string') {
          dealIdHex = ethers.hexlify(dealIdHex);
        }
        // Ensure it's a complete bytes32 (66 chars with 0x prefix)
        if (!dealIdHex.startsWith('0x')) {
          dealIdHex = '0x' + dealIdHex;
        }
        // Pad to 66 characters if needed (0x + 64 hex chars)
        if (dealIdHex.length < 66) {
          dealIdHex = dealIdHex.padEnd(66, '0');
        }
        
        // Log for debugging
        console.log(`Loaded deal - Original dealId from array: ${dealId}, deal.dealId from contract: ${deal.dealId}, normalized: ${dealIdHex}`);
        
        // Get relay endpoint from on-chain registry
        let relayEndpoint = '';
        try {
          if (relayRegistry && deal.relay) {
            const relayInfo = await relayRegistry.getRelayInfo(deal.relay);
            relayEndpoint = relayInfo.endpoint || '';
            console.log(`Relay endpoint for deal ${dealIdHex}: ${relayEndpoint}`);
          }
        } catch (relayError) {
          console.warn(`Could not fetch relay endpoint for ${deal.relay}:`, relayError);
        }
        
        allDeals.push({
          dealId: dealIdHex,
          cid: deal.cid,
          relay: deal.relay,
          relayEndpoint: relayEndpoint,
          sizeMB: Number(deal.sizeMB),
          priceUSDC: ethers.formatUnits(deal.priceUSDC, 6),
          createdAt: new Date(Number(deal.createdAt) * 1000),
          expiresAt: new Date(Number(deal.expiresAt) * 1000),
          active: isActive,
          clientStake: ethers.formatUnits(deal.clientStake, 6),
        });
      } catch (e) {
        console.error(`Error loading deal ${dealId}:`, e);
      }
    }

    // Update stats with all deals
    updateStats(total, active, totalSizeMB, totalSpent);
    
    // Filter deals for display (default: only active)
    const showAllDeals = document.getElementById('showAllDeals')?.checked || false;
    const deals = showAllDeals ? allDeals : allDeals.filter(deal => deal.active);
    
    if (deals.length === 0) {
      const message = showAllDeals 
        ? 'No deals found'
        : 'No active deals found. Check "Show all deals" to see expired or terminated deals.';
      dealsList.innerHTML = `
        <div class="text-center text-[#A0A0A0] py-8">
          <p>${message}</p>
          ${!showAllDeals ? `<p class="text-sm mt-2">Create your first storage deal to get started</p>` : ''}
        </div>
      `;
      return;
    }

    dealsList.innerHTML = deals.map(deal => `
      <div class="deal-card ${deal.active ? 'active' : 'expired'}">
        <div class="flex justify-between items-start mb-3">
          <div>
            <div class="text-[#FFFFFF] font-medium">${truncateAddress(deal.dealId)}</div>
            <span class="status-badge status-${deal.active ? 'active' : 'expired'}">${deal.active ? 'Active' : 'Expired'}</span>
          </div>
        </div>
        
        <div class="mb-3 p-2 bg-[#1A1A1A] rounded-lg border border-[#404040]">
          <div class="text-[#606060] text-xs mb-1">IPFS CID</div>
          <code class="text-[#A0A0A0] text-xs font-mono break-all block">${deal.cid}</code>
        </div>
        
        <div class="grid grid-cols-3 gap-4 text-sm mb-3">
          <div>
            <div class="text-[#606060]">Size</div>
            <div class="text-[#A0A0A0]">${deal.sizeMB} MB</div>
          </div>
          <div>
            <div class="text-[#606060]">Price</div>
            <div class="text-[#A0A0A0]">${deal.priceUSDC} USDC</div>
          </div>
          <div>
            <div class="text-[#606060]">Expires</div>
            <div class="text-[#A0A0A0]">${deal.expiresAt.toLocaleDateString()}</div>
          </div>
        </div>
        
        ${deal.clientStake !== '0.0' ? `
          <div class="text-sm mb-3">
            <span class="text-[#606060]">Client Stake:</span>
            <span class="text-[#A0A0A0]">${deal.clientStake} USDC</span>
          </div>
        ` : ''}
        
        <div class="flex items-center justify-between mt-3 pt-3 border-t border-[#404040]">
          <div class="text-xs text-[#606060]">
            Relay: <a href="${CONTRACTS[currentChainId].explorer}/address/${deal.relay}" target="_blank" class="text-[#42A5F5] hover:underline">${truncateAddress(deal.relay)}</a>
          </div>
          <div class="flex gap-2 flex-wrap">
            <button onclick="viewDealFile('${deal.cid}', '${deal.relayEndpoint || ''}')" 
               class="btn btn-sm bg-[#42A5F5] hover:bg-[#1976D2] border-0 text-white text-xs px-3 py-1">
              View
            </button>
            <button onclick="downloadDealFile('${deal.cid}', '${deal.relayEndpoint || ''}', '${deal.dealId}')" 
               class="btn btn-sm bg-[#4CAF50] hover:bg-[#388E3C] border-0 text-white text-xs px-3 py-1">
              Download
            </button>
            ${deal.active ? `
              <button onclick="verifyDeal('${deal.dealId}')" class="btn btn-sm bg-[#42A5F5] hover:bg-[#1976D2] border-0 text-white text-xs px-3 py-1">
                Verify
              </button>
              <button onclick="completeDeal('${deal.dealId}')" class="btn btn-sm bg-[#FF9800] hover:bg-[#F57C00] border-0 text-white text-xs px-3 py-1">
                Complete
              </button>
              <button onclick="showGriefModal('${deal.dealId}', '${deal.cid}', '${deal.relay}')" class="btn btn-sm bg-[#F44336] hover:bg-[#D32F2F] border-0 text-white text-xs px-3 py-1">
                Report Issue
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Load deals error:', error);
    document.getElementById('dealsList').innerHTML = `
      <div class="text-center text-[#F44336] py-8">
        Error loading deals: ${error.message}
      </div>
    `;
  }
}

function updateStats(total, active, storage, spent) {
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statActive').textContent = active;
  document.getElementById('statStorage').textContent = Math.round(storage);
  document.getElementById('statSpent').textContent = `$${spent.toFixed(4)}`;
}

// Update deal preview on input change
['dealCid', 'dealSizeMB', 'dealDuration', 'dealTier', 'dealRelay'].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('change', () => {
      calculatePrice();
      updateRelayInfo().catch(err => console.error('Error updating relay info:', err));
    });
    if (id !== 'dealRelay' && id !== 'dealCid') {
      el.addEventListener('input', calculatePrice);
    }
  }
});

// Calculate price on page load if fields are filled
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (document.getElementById('dealSizeMB')?.value && document.getElementById('dealDuration')?.value) {
      calculatePrice();
    }
  }, 500);
});

// Tier card selection
document.querySelectorAll('.tier-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.tier-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    const tier = card.dataset.tier;
    if (document.getElementById('calcTier')) document.getElementById('calcTier').value = tier;
    if (document.getElementById('dealTier')) document.getElementById('dealTier').value = tier;
    calculatePrice();
  });
});

// Helper functions
function showMessage(elementId, type, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  
  el.className = `message ${type}`;
  el.textContent = message;
  el.style.display = 'block';
  
  setTimeout(() => {
    el.style.display = 'none';
  }, 10000);
}

function truncateAddress(addr) {
  if (!addr) return '-';
  const str = typeof addr === 'string' ? addr : ethers.hexlify(addr);
  return `${str.slice(0, 6)}...${str.slice(-4)}`;
}

// File upload handling
let selectedFile = null;
let uploadedCID = null;

function handleFileSelect() {
  console.log('📁 handleFileSelect() called');
  const fileInput = document.getElementById('dealFile');
  const uploadBtn = document.getElementById('uploadBtn');
  
  if (!fileInput) {
    console.error('❌ File input not found');
    return;
  }
  
  if (!uploadBtn) {
    console.error('❌ Upload button not found');
    return;
  }
  
  if (fileInput.files && fileInput.files.length > 0) {
    selectedFile = fileInput.files[0];
    console.log('📁 File selected:', selectedFile.name, selectedFile.size, 'bytes');
    uploadBtn.style.display = 'block';
    uploadBtn.disabled = false;
    document.getElementById('dealCid').value = '';
    const uploadStatus = document.getElementById('uploadStatus');
    if (uploadStatus) {
      uploadStatus.style.display = 'none';
    }
  } else {
    console.log('📁 No file selected');
    selectedFile = null;
    uploadBtn.style.display = 'none';
  }
}

// Upload file to IPFS via relay
/**
 * Initializes ShogunCore and derives GunDB keypair from wallet
 * Called automatically when wallet connects
 */
async function deriveGunKeypair() {
  if (!connectedAddress || !signer) {
    console.warn('Cannot derive keypair: wallet not connected');
    return;
  }

  try {
    // Check if ShogunCore is available
    if (!window.ShogunCore) {
      throw new Error('ShogunCore not loaded. Make sure shogun-core.js is loaded after Gun.js');
    }

    // Initialize ShogunCore if not already initialized
    if (!shogunCore) {
      // Create a minimal Gun instance for ShogunCore (we don't need a full relay connection)
      const gunInstance = window.Gun({
        peers: [], // No peers needed for key derivation
        localStorage: false, // Don't persist data
      });

      // Initialize ShogunCore with correct config format
      // Use gunInstance (not gun) and enable web3 plugin
      shogunCore = new window.ShogunCore.ShogunCore({
        gunInstance: gunInstance, // Correct property name
        web3: { enabled: true }, // Enable web3 plugin
      });

      // Wait for initialization
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Get Web3 plugin
    const web3Plugin = shogunCore.getPlugin('web3');
    if (!web3Plugin) {
      throw new Error('Web3 plugin not available in ShogunCore');
    }

    // Connect MetaMask through ShogunCore
    const connectionResult = await web3Plugin.connectMetaMask();
    if (!connectionResult.success || !connectionResult.address) {
      throw new Error('Failed to connect MetaMask through ShogunCore');
    }

    // Generate credentials (this derives the keypair)
    const credentials = await web3Plugin.generateCredentials(connectedAddress);
    
    // Convert ISEAPair to our format
    gunKeypair = {
      pub: credentials.pub,
      priv: credentials.priv,
      epub: credentials.epub,
      epriv: credentials.epriv,
    };
    
    console.log('✅ GunDB keypair derived successfully via ShogunCore');
    console.log('Keypair pub:', gunKeypair.pub.substring(0, 20) + '...');
    
    // Update registration UI if it's visible
    const registerTab = document.getElementById('tab-register');
    if (registerTab && registerTab.style.display !== 'none') {
      loadRegistrationStatus();
    }
  } catch (error) {
    console.error('❌ Failed to derive GunDB keypair:', error);
    // Don't block wallet connection if keypair derivation fails
    // User can still use the app, but encryption won't be available
    showMessage('createMessage', 'warning', 
      'Could not derive encryption keys. Files will be uploaded unencrypted. ' +
      'Error: ' + error.message
    );
  }
}

async function uploadToIPFS() {
  console.log('📤 uploadToIPFS() called');
  console.log('selectedFile:', selectedFile);
  console.log('connectedAddress:', connectedAddress);
  
  if (!selectedFile) {
    console.error('❌ No file selected');
    showMessage('createMessage', 'error', 'Please select a file first');
    return;
  }

  if (!connectedAddress) {
    console.error('❌ Wallet not connected');
    showMessage('createMessage', 'error', 'Please connect your wallet first');
    return;
  }
  
  // Ensure keypair is derived (in case it failed during connection)
  if (!gunKeypair) {
    try {
      await deriveGunKeypair();
    } catch (error) {
      console.warn('Keypair derivation failed, proceeding with unencrypted upload');
    }
  }

  // Get relay endpoint from selected relay
  const relaySelect = document.getElementById('dealRelay');
  if (!relaySelect) {
    console.error('❌ Relay select element not found');
    showMessage('createMessage', 'error', 'Relay selector not found');
    return;
  }
  
  const selectedOption = relaySelect.options[relaySelect.selectedIndex];
  const relayEndpoint = selectedOption?.dataset.endpoint;
  
  console.log('relaySelect:', relaySelect.value);
  console.log('selectedOption:', selectedOption);
  console.log('relayEndpoint:', relayEndpoint);

  if (!relayEndpoint) {
    console.error('❌ No relay endpoint found');
    console.error('relaySelect value:', relaySelect?.value);
    console.error('selectedOption:', selectedOption);
    console.error('All options:', Array.from(relaySelect?.options || []).map(opt => ({ value: opt.value, endpoint: opt.dataset.endpoint })));
    showMessage('createMessage', 'error', 'Please select a relay first. The relay must be selected before uploading to IPFS.');
    return;
  }

  try {
    const uploadBtn = document.getElementById('uploadBtn');
    const uploadStatus = document.getElementById('uploadStatus');
    
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';
    uploadStatus.style.display = 'block';
    
    // Check if encryption is enabled
    const encryptionCheckbox = document.getElementById('dealEncryptionEnabled');
    const encryptionEnabled = encryptionCheckbox ? encryptionCheckbox.checked : false;
    
    if (encryptionEnabled) {
      uploadStatus.textContent = `Encrypting and uploading ${selectedFile.name} (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)...`;
    } else {
      uploadStatus.textContent = `Uploading ${selectedFile.name} as public file (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)...`;
    }
    
    // Encrypt file using SEA with signature-based token (more secure than address)
    // This requires user to sign a message to prove key ownership
    let fileToUpload = selectedFile;
    let isEncrypted = false;
    let encryptionToken = null;
    let encryptionMessage = null;
    
    if (encryptionEnabled && connectedAddress && signer && window.Gun && window.Gun.SEA) {
      try {
        uploadStatus.textContent = `Requesting signature for encryption...`;
        
        // Create a deterministic message for encryption
        // Same message for all files from this user, allows deterministic key derivation
        encryptionMessage = 'I Love Shogun';
        
        // Request signature from user
        showMessage('createMessage', 'info', 'Please sign the message in your wallet to encrypt the file...');
        const signature = await signer.signMessage(encryptionMessage);
        
        // Verify signature (sanity check)
        const recoveredAddress = ethers.verifyMessage(encryptionMessage, signature);
        if (recoveredAddress.toLowerCase() !== connectedAddress.toLowerCase()) {
          throw new Error('Signature verification failed');
        }
        
        uploadStatus.textContent = `Encrypting ${selectedFile.name}...`;
        
        // Use same encryption approach as upload.html
        const base64data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.onerror = (err) => reject(err);
          reader.readAsDataURL(selectedFile);
        });
        
        // Encrypt using SEA with signature as token (more secure than address)
        const encrypted = await window.Gun.SEA.encrypt(base64data, signature);
        
        // Stringify the encrypted object to JSON before creating the File
        // This ensures it's saved as valid JSON on IPFS, not as "[object Object]"
        const encryptedString = JSON.stringify(encrypted);
        
        // Create encrypted file with .enc extension and text/plain type (same as upload.html)
        const baseFileName = selectedFile.name;
        const encryptionFileName = baseFileName.endsWith(".enc")
          ? baseFileName
          : `${baseFileName}.enc`;
        
        fileToUpload = new File([encryptedString], encryptionFileName, {
          type: "text/plain",
        });
        
        encryptionToken = signature;
        isEncrypted = true;
        console.log('✅ File encrypted with SEA using signature as token');
        uploadStatus.textContent = `Uploading encrypted ${selectedFile.name}...`;
      } catch (encryptError) {
        console.error('❌ Encryption failed:', encryptError);
        if (encryptError.message && encryptError.message.includes('User rejected')) {
          showMessage('createMessage', 'error', 'Signature rejected. File not uploaded.');
          uploadBtn.disabled = false;
          uploadBtn.textContent = 'Upload to IPFS';
          uploadStatus.style.display = 'none';
          return;
        } else {
          // Encryption was enabled but failed - ask user if they want to proceed unencrypted
          const proceedUnencrypted = confirm('Encryption failed. Do you want to upload the file as unencrypted (public)?');
          if (!proceedUnencrypted) {
            uploadBtn.disabled = false;
            uploadBtn.textContent = 'Upload to IPFS';
            uploadStatus.style.display = 'none';
            return;
          }
          showMessage('createMessage', 'warning', 'File will be uploaded as unencrypted (public). ' + encryptError.message);
          isEncrypted = false;
          uploadStatus.textContent = `Uploading unencrypted ${selectedFile.name}...`;
        }
      }
    } else if (encryptionEnabled) {
      // Encryption was requested but not available
      showMessage('createMessage', 'warning', 'Encryption requested but not available. Uploading as unencrypted (public) file.');
      uploadStatus.textContent = `Uploading unencrypted ${selectedFile.name}...`;
    }

    const formData = new FormData();
    formData.append('file', fileToUpload);
    
    // Add encryption info if file is encrypted (for metadata tracking)
    if (isEncrypted) {
      formData.append('encrypted', 'true');
      formData.append('encryptionMethod', 'SEA');
      // Store token for later decryption (this is just metadata, actual decryption uses /decrypt endpoint)
      formData.append('encryptionToken', encryptionToken);
    } else {
      formData.append('encrypted', 'false');
      formData.append('public', 'true');
    }

    // Upload to relay's IPFS endpoint
    // Mark this as a deal upload (no subscription required, deal is paid on-chain)
    console.log(`📤 Uploading to: ${relayEndpoint}/api/v1/ipfs/upload`);
    console.log(`📤 File: ${selectedFile.name}, Size: ${selectedFile.size} bytes`);
    console.log(`📤 User Address: ${connectedAddress}`);
    
    const response = await fetch(`${relayEndpoint}/api/v1/ipfs/upload?deal=true`, {
      method: 'POST',
      headers: {
        'X-User-Address': connectedAddress,
        'X-Deal-Upload': 'true',
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Upload failed:', response.status, errorText);
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch (e) {
        errorData = { error: errorText || `Upload failed with status ${response.status}` };
      }
      throw new Error(errorData.error || `Upload failed: ${response.status}`);
    }

    const data = await response.json();
    console.log('✅ Upload response:', data);
    
    // Extract CID from response - can be in data.cid or data.file.hash
    const cid = data.cid || (data.file && data.file.hash);
    
    if (data.success && cid) {
      uploadedCID = cid;
      document.getElementById('dealCid').value = cid;
      if (isEncrypted) {
        uploadStatus.textContent = `✅ Uploaded encrypted file! CID: ${cid}`;
        showMessage('createMessage', 'success', `Encrypted file uploaded to IPFS: ${cid}`);
      } else {
        uploadStatus.textContent = `✅ Uploaded public file! CID: ${cid}`;
        showMessage('createMessage', 'success', `Public file uploaded to IPFS: ${cid}`);
      }
      uploadStatus.style.color = '#4CAF50';
      
      // Auto-fill size if available (from file.size or sizeMB)
      const fileSizeMB = data.sizeMB || (data.file && data.file.size && (data.file.size / (1024 * 1024)));
      if (fileSizeMB) {
        document.getElementById('dealSizeMB').value = Math.ceil(fileSizeMB);
        calculatePrice();
      }
    } else {
      throw new Error('Upload succeeded but no CID returned');
    }
  } catch (error) {
    console.error('Upload error:', error);
    showMessage('createMessage', 'error', `Upload failed: ${error.message}`);
    document.getElementById('uploadStatus').textContent = `❌ Upload failed: ${error.message}`;
    document.getElementById('uploadStatus').style.color = '#F44336';
  } finally {
    const uploadBtn = document.getElementById('uploadBtn');
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload to IPFS';
  }
}

// Verify deal - check if IPFS CID is still available
async function verifyDeal(dealId) {
  if (!connectedAddress || !signer) {
    alert('Please connect your wallet first');
    return;
  }

  try {
    // Show loading indicator
    const verifyBtn = event?.target || document.querySelector(`button[onclick*="verifyDeal('${dealId}')"]`);
    if (verifyBtn) {
      verifyBtn.disabled = true;
      verifyBtn.textContent = 'Verifying...';
    }
    
    console.log('🔍 Starting verification for deal:', dealId);
    
    // Normalize dealId to ensure it's a complete bytes32
    let normalizedDealId = dealId;
    if (typeof normalizedDealId !== 'string') {
      normalizedDealId = ethers.hexlify(normalizedDealId);
    }
    if (!normalizedDealId.startsWith('0x')) {
      normalizedDealId = '0x' + normalizedDealId;
    }
    // Pad to 66 characters if needed (0x + 64 hex chars)
    if (normalizedDealId.length < 66) {
      normalizedDealId = normalizedDealId.padEnd(66, '0');
    }
    
    console.log(`Verifying deal - Original: ${dealId}, Normalized: ${normalizedDealId}`);
    
    // Get deal info
    const deal = await storageDealRegistry.getDeal(normalizedDealId);
    if (!deal || deal.client.toLowerCase() !== connectedAddress.toLowerCase()) {
      throw new Error('Deal not found or not owned by you');
    }

    // Get relay endpoint
    const relayInfo = await relayRegistry.getRelayInfo(deal.relay);
    const endpoint = relayInfo?.endpoint || '';
    if (!endpoint) {
      throw new Error('Relay endpoint not available');
    }

    // Use relay's verify endpoint with deal ID directly (no onchain_ prefix needed)
    // The endpoint will handle on-chain lookup automatically
    // Pass clientAddress and CID as query parameters to help with deal lookup
    const verifyUrl = `${endpoint}/api/v1/deals/${normalizedDealId}/verify?clientAddress=${encodeURIComponent(connectedAddress)}&cid=${encodeURIComponent(deal.cid)}`;
    console.log(`🔍 Verifying deal at: ${verifyUrl}`);
    const verifyResponse = await fetch(verifyUrl);
    
    if (verifyResponse.ok) {
      const verifyData = await verifyResponse.json();
      console.log('📋 Verification response:', verifyData);
      
      if (verifyData.success) {
        const verification = verifyData.verification || {};
        
        if (verification.verified) {
          // Deal is verified successfully
          const checks = verification.checks || {};
          const sizeMB = checks.blockSize ? (checks.blockSize / (1024 * 1024)).toFixed(2) : 'unknown';
          const message = `✅ Verification successful! CID ${deal.cid} is pinned and verified on relay. Size: ${sizeMB} MB`;
          console.log(message);
          alert(message);
          if (verifyBtn) {
            verifyBtn.textContent = '✅ Verified';
            verifyBtn.style.backgroundColor = '#4CAF50';
          }
          return;
        } else {
          // Deal found but verification failed - show issues
          const issues = verification.issues || [];
          const issuesText = issues.length > 0 ? issues.join(', ') : 'CID not found in relay storage';
          const message = `⚠️ Verification failed: ${issuesText}. You may want to report this issue using the "Report Issue" button.`;
          console.warn(message);
          alert(message);
          if (verifyBtn) {
            verifyBtn.textContent = '⚠️ Failed';
            verifyBtn.style.backgroundColor = '#FF9800';
          }
          return;
        }
      } else {
        // Backend returned success: false
        const message = `❌ Verification error: ${verifyData.error || 'Unknown error'}`;
        console.error(message);
        alert(message);
        if (verifyBtn) {
          verifyBtn.textContent = '❌ Error';
          verifyBtn.style.backgroundColor = '#F44336';
        }
        return;
      }
    } else if (verifyResponse.status === 404) {
      // Deal not found in relay - try alternative verification via public gateways
      showMessage('createMessage', 'warning', 
        `⚠️ Deal not found in relay's database. Trying public IPFS gateways...`
      );
      
      // Fallback: Try direct IPFS gateway check
      try {
        // Try multiple gateways
        const gateways = [
          `https://ipfs.io/ipfs/${deal.cid}`,
          `https://gateway.pinata.cloud/ipfs/${deal.cid}`,
          `https://cloudflare-ipfs.com/ipfs/${deal.cid}`,
        ];
        
        let found = false;
        for (const gateway of gateways) {
          try {
            const gatewayResponse = await fetch(gateway, {
              method: 'HEAD',
              mode: 'no-cors',
            });
            // If no error, assume it's available (no-cors doesn't give status)
            found = true;
            break;
          } catch (e) {
            continue;
          }
        }
        
        if (found) {
          showMessage('createMessage', 'info', 
            `ℹ️ CID ${deal.cid} appears to be available on public IPFS gateways, but relay verification failed. Consider reporting this issue.`
          );
        } else {
          showMessage('createMessage', 'error', 
            `❌ Verification failed: CID ${deal.cid} not found on relay or public gateways. Consider reporting this issue.`
          );
        }
      } catch (e) {
        showMessage('createMessage', 'error', 
          `❌ Verification failed: ${e.message}. Consider reporting this issue.`
        );
      }
    } else {
      const errorData = await verifyResponse.json().catch(() => ({}));
      throw new Error(errorData.error || `Verification failed: ${verifyResponse.status}`);
    }
  } catch (error) {
    console.error('Verification error:', error);
    const message = `Verification failed: ${error.message}`;
    alert(message);
    const verifyBtn = event?.target || document.querySelector(`button[onclick*="verifyDeal('${dealId}')"]`);
    if (verifyBtn) {
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verify';
      verifyBtn.style.backgroundColor = '';
    }
  } finally {
    // Reset button state if not already reset
    const verifyBtn = event?.target || document.querySelector(`button[onclick*="verifyDeal('${dealId}')"]`);
    if (verifyBtn && verifyBtn.disabled && verifyBtn.textContent === 'Verifying...') {
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verify';
    }
  }
}

// Show grief modal with detailed information
async function showGriefModal(dealId, cid, relayAddress) {
  if (!connectedAddress || !signer) {
    showMessage('createMessage', 'error', 'Please connect your wallet first');
    return;
  }

  try {
    // Get deal info
    const deal = await storageDealRegistry.getDeal(dealId);
    if (!deal || deal.client.toLowerCase() !== connectedAddress.toLowerCase()) {
      showMessage('createMessage', 'error', 'Deal not found or not owned by you');
      return;
    }

    // Get relay info
    const relayInfo = await relayRegistry.getRelayInfo(relayAddress);
    const relayStake = ethers.formatUnits(relayInfo.stakedAmount, 6);
    
    // Get griefing ratios
    const ratios = await getGriefingRatios();
    const griefingRatio = deal.clientStake > 0 ? ratios.staked : ratios.default;
    const griefingRatioPercent = (Number(griefingRatio) / 100).toFixed(2); // Convert basis points to percentage

    // Create modal if it doesn't exist
    let modal = document.getElementById('griefModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'griefModal';
      modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
      modal.innerHTML = `
        <div class="bg-[#282828] border border-[#404040] rounded-2xl p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
          <h3 class="text-xl font-bold text-[#FFFFFF] mb-4">Report Issue / Grief Relay</h3>
          <div class="space-y-4">
            <!-- Relay Info -->
            <div class="bg-[#1A1A1A] border border-[#404040] rounded-lg p-4">
              <h4 class="text-[#FFFFFF] font-medium mb-2">Relay Information</h4>
              <div class="space-y-1 text-sm">
                <div class="flex justify-between">
                  <span class="text-[#A0A0A0]">Relay Address:</span>
                  <span class="text-[#FFFFFF] font-mono">${relayAddress.slice(0, 6)}...${relayAddress.slice(-4)}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-[#A0A0A0]">Current Stake:</span>
                  <span class="text-[#42A5F5] font-semibold">${relayStake} USDC</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-[#A0A0A0]">Your Client Stake:</span>
                  <span class="text-[#FFFFFF]">${deal.clientStake > 0 ? ethers.formatUnits(deal.clientStake, 6) : '0'} USDC</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-[#A0A0A0]">Griefing Ratio:</span>
                  <span class="text-[#FF9800] font-semibold">${griefingRatioPercent}%</span>
                </div>
                <div class="text-[#606060] text-xs mt-2">
                  ${deal.clientStake > 0 
                    ? '✓ You have client stake - using lower griefing ratio' 
                    : 'ℹ️ No client stake - using default griefing ratio'}
                </div>
              </div>
            </div>

            <!-- Issue Details -->
            <div>
              <label class="text-[#A0A0A0] text-sm mb-2 block">Issue Type</label>
              <select id="griefType" class="input-field">
                <option value="dataLoss">Data Loss - CID not available</option>
                <option value="missedProof">Missed Proof - Relay failed to provide proof</option>
              </select>
            </div>
            <div>
              <label class="text-[#A0A0A0] text-sm mb-2 block">Reason / Evidence</label>
              <textarea id="griefReason" class="input-field" rows="3" placeholder="Describe the issue..."></textarea>
            </div>
            
            <!-- Slash Amount Input -->
            <div>
              <label class="text-[#A0A0A0] text-sm mb-2 block">Slash Amount (USDC)</label>
              <input type="number" id="griefSlashAmount" class="input-field" placeholder="0.1" min="0" step="0.001" oninput="updateGriefingCost()">
              <p class="text-[#606060] text-xs mt-1">Amount to slash from relay stake (max: ${relayStake} USDC)</p>
            </div>

            <!-- Cost Calculation -->
            <div id="griefCostInfo" class="bg-[#1A1A1A] border border-[#404040] rounded-lg p-4" style="display: none;">
              <h4 class="text-[#FFFFFF] font-medium mb-2">Cost Breakdown</h4>
              <div class="space-y-2 text-sm">
                <div class="flex justify-between">
                  <span class="text-[#A0A0A0]">Slash Amount:</span>
                  <span class="text-[#FFFFFF]" id="griefSlashDisplay">-</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-[#A0A0A0]">Griefing Ratio:</span>
                  <span class="text-[#FF9800]">${griefingRatioPercent}%</span>
                </div>
                <div class="border-t border-[#404040] pt-2 mt-2">
                  <div class="flex justify-between items-center">
                    <span class="text-[#A0A0A0] font-medium">Your Cost:</span>
                    <span class="text-[#F44336] font-bold text-lg" id="griefCostDisplay">-</span>
                  </div>
                  <p class="text-[#606060] text-xs mt-1">This is the amount you need to pay to grief the relay</p>
                </div>
              </div>
            </div>

            <div id="griefStatus" class="text-sm" style="display: none;"></div>
            <div class="flex gap-2">
              <button onclick="closeGriefModal()" class="btn flex-1 bg-[#404040] hover:bg-[#505050] border-0 text-white">Cancel</button>
              <button onclick="submitGrief('${dealId}')" id="submitGriefBtn" class="btn flex-1 bg-[#F44336] hover:bg-[#D32F2F] border-0 text-white">Submit Grief</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      
      // Store deal info for cost calculation
      modal.dataset.dealId = dealId;
      modal.dataset.griefingRatio = griefingRatio;
      modal.dataset.relayStake = relayStake;
    } else {
      // Update existing modal with new data
      modal.dataset.dealId = dealId;
      modal.dataset.griefingRatio = griefingRatio;
      modal.dataset.relayStake = relayStake;
      
      // Update relay info display
      const relayInfoSection = modal.querySelector('.bg-\\[\\#1A1A1A\\]');
      if (relayInfoSection) {
        const stakeElement = relayInfoSection.querySelector('.text-\\[\\#42A5F5\\]');
        if (stakeElement) stakeElement.textContent = `${relayStake} USDC`;
        
        const clientStakeElement = Array.from(relayInfoSection.querySelectorAll('.text-\\[\\#FFFFFF\\]')).find(el => el.textContent.includes('USDC'));
        if (clientStakeElement) {
          clientStakeElement.textContent = `${deal.clientStake > 0 ? ethers.formatUnits(deal.clientStake, 6) : '0'} USDC`;
        }
        
        const ratioElement = relayInfoSection.querySelector('.text-\\[\\#FF9800\\]');
        if (ratioElement) {
          const griefingRatioPercent = (Number(griefingRatio) / 100).toFixed(2);
          ratioElement.textContent = `${griefingRatioPercent}%`;
        }
      }
    }

    modal.style.display = 'flex';
    document.getElementById('griefReason').value = `CID ${cid} verification failed or data not available`;
    document.getElementById('griefSlashAmount').value = '0.1';
    
    // Trigger initial cost calculation
    updateGriefingCost();
  } catch (error) {
    console.error('Error showing grief modal:', error);
    showMessage('createMessage', 'error', `Failed to load grief information: ${error.message}`);
  }
}

// Update griefing cost display in real-time
async function updateGriefingCost() {
  const modal = document.getElementById('griefModal');
  if (!modal) return;

  const slashAmountInput = document.getElementById('griefSlashAmount');
  const costInfo = document.getElementById('griefCostInfo');
  const slashDisplay = document.getElementById('griefSlashDisplay');
  const costDisplay = document.getElementById('griefCostDisplay');

  if (!slashAmountInput || !costInfo || !slashDisplay || !costDisplay) return;

  const slashAmount = parseFloat(slashAmountInput.value);
  const griefingRatio = BigInt(modal.dataset.griefingRatio || '500');
  const relayStake = parseFloat(modal.dataset.relayStake || '0');

  if (slashAmount > 0 && slashAmount <= relayStake) {
    const slashAmountAtomic = ethers.parseUnits(slashAmount.toFixed(6), 6);
    const costAtomic = (slashAmountAtomic * griefingRatio) / 10000n;
    const cost = ethers.formatUnits(costAtomic, 6);

    slashDisplay.textContent = `${slashAmount.toFixed(6)} USDC`;
    costDisplay.textContent = `${cost} USDC`;
    costInfo.style.display = 'block';
  } else if (slashAmount > relayStake) {
    slashDisplay.textContent = `${slashAmount.toFixed(6)} USDC`;
    costDisplay.textContent = 'Invalid (exceeds relay stake)';
    costDisplay.className = 'text-[#F44336] font-bold text-lg';
    costInfo.style.display = 'block';
  } else {
    costInfo.style.display = 'none';
  }
}

// Complete deal (mark as completed on-chain)
async function completeDeal(dealId) {
  if (!connectedAddress || !signer || !storageDealRegistry) {
    showMessage('createMessage', 'error', 'Please connect your wallet first');
    return;
  }

  if (!confirm(`Are you sure you want to complete this deal? This will mark it as completed on-chain.`)) {
    return;
  }

  try {
    showMessage('createMessage', 'info', 'Completing deal on-chain...');

    // Normalize dealId
    let normalizedDealId = dealId;
    if (typeof normalizedDealId !== 'string') {
      normalizedDealId = ethers.hexlify(normalizedDealId);
    }
    if (!normalizedDealId.startsWith('0x')) {
      normalizedDealId = '0x' + normalizedDealId;
    }
    if (normalizedDealId.length < 66) {
      normalizedDealId = normalizedDealId.padEnd(66, '0');
    }

    const tx = await storageDealRegistry.completeDeal(normalizedDealId);
    showMessage('createMessage', 'info', `Transaction submitted: ${tx.hash}. Waiting for confirmation...`);

    const receipt = await tx.wait();
    if (receipt.status === 1) {
      showMessage('createMessage', 'success', `Deal completed successfully! TX: ${receipt.hash}`);
      setTimeout(() => {
        loadMyDeals();
      }, 2000);
    } else {
      throw new Error('Transaction failed');
    }
  } catch (error) {
    console.error('Complete deal error:', error);
    showMessage('createMessage', 'error', `Failed to complete deal: ${error.message}`);
  }
}

function closeGriefModal() {
  const modal = document.getElementById('griefModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

// Submit grief transaction
async function submitGrief(dealId) {
  if (!connectedAddress || !signer || !storageDealRegistry) {
    showMessage('createMessage', 'error', 'Please connect your wallet first');
    return;
  }

  const griefType = document.getElementById('griefType').value;
  const reason = document.getElementById('griefReason').value;
  const slashAmount = parseFloat(document.getElementById('griefSlashAmount').value);
  const submitBtn = document.getElementById('submitGriefBtn');
  const statusEl = document.getElementById('griefStatus');

  if (!reason || slashAmount <= 0) {
    statusEl.textContent = 'Please fill in reason and slash amount';
    statusEl.style.color = '#F44336';
    statusEl.style.display = 'block';
    return;
  }

  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing...';
    statusEl.style.display = 'block';
    statusEl.textContent = 'Preparing grief transaction...';
    statusEl.style.color = '#42A5F5';

    // Get deal info to calculate griefing cost
    const deal = await storageDealRegistry.getDeal(dealId);
    if (!deal || deal.client.toLowerCase() !== connectedAddress.toLowerCase()) {
      throw new Error('Deal not found or not owned by you');
    }

    // Get griefing ratio from registry
    const ratios = await getGriefingRatios();
    const griefingRatio = deal.clientStake > 0 
      ? ratios.staked
      : ratios.default;

    const slashAmountAtomic = ethers.parseUnits(slashAmount.toFixed(6), 6);
    const griefingCost = (slashAmountAtomic * BigInt(griefingRatio)) / 10000n;

    // Check balance and approval for griefing cost
    const balance = await usdc.balanceOf(connectedAddress);
    if (balance < griefingCost) {
      throw new Error(`Insufficient USDC for griefing cost. Need: ${ethers.formatUnits(griefingCost, 6)}`);
    }

    // Use address from SDK instead of hardcoded CONTRACTS
    const storageDealRegistryAddress = storageDealRegistry.getAddress();
    const allowance = await usdc.allowance(connectedAddress, storageDealRegistryAddress);
    if (allowance < griefingCost) {
      statusEl.textContent = 'Approving USDC for griefing cost...';
      const approveTx = await usdc.approve(storageDealRegistryAddress, griefingCost * 2n);
      await approveTx.wait();
    }

    // Call grief function on StorageDealRegistry
    statusEl.textContent = 'Submitting grief transaction...';
    const griefTx = await storageDealRegistry.grief(dealId, slashAmountAtomic, reason);
    const receipt = await griefTx.wait();

    if (receipt.status === 1) {
      statusEl.textContent = `✅ Grief submitted! TX: ${receipt.hash}`;
      statusEl.style.color = '#4CAF50';
      showMessage('createMessage', 'success', `Grief submitted successfully. TX: ${receipt.hash}`);
      
      setTimeout(() => {
        closeGriefModal();
        loadMyDeals();
      }, 2000);
    } else {
      throw new Error('Transaction failed');
    }
  } catch (error) {
    console.error('Grief error:', error);
    statusEl.textContent = `❌ Error: ${error.message}`;
    statusEl.style.color = '#F44336';
    showMessage('createMessage', 'error', `Grief failed: ${error.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Grief';
  }
}

// Helper to get griefing ratios from registry
async function getGriefingRatios() {
  if (!relayRegistry) {
    throw new Error('Relay registry not initialized');
  }
  
  const [defaultRatio, stakedRatio] = await Promise.all([
    relayRegistry.defaultGriefingRatio(),
    relayRegistry.stakedClientGriefingRatio(),
  ]);
  
  return {
    default: Number(defaultRatio),
    staked: Number(stakedRatio),
  };
}

// ==================== SUBSCRIPTIONS ====================

// Load relays for subscription selection
async function loadSubscriptionRelays() {
  if (!relayRegistry) return;

  const relaySelect = document.getElementById('subscriptionRelaySelect');
  if (!relaySelect) return;

  relaySelect.innerHTML = '<option value="">Loading relays...</option>';
  relaySelect.disabled = true;

  try {
    const addresses = await relayRegistry.getActiveRelays();
    
    if (addresses.length === 0) {
      relaySelect.innerHTML = '<option value="">No relays available</option>';
      return;
    }

    relaySelect.innerHTML = '<option value="">Choose a relay...</option>';
    
    for (const addr of addresses) {
      try {
        const info = await relayRegistry.getRelayInfo(addr);
        const endpoint = info.endpoint || '';
        const option = document.createElement('option');
        option.value = addr;
        option.textContent = `${addr.slice(0, 6)}...${addr.slice(-4)} - ${endpoint || 'No endpoint'}`;
        option.dataset.endpoint = endpoint;
        relaySelect.appendChild(option);
      } catch (e) {
        console.error(`Error loading relay ${addr}:`, e);
      }
    }
    
    relaySelect.disabled = false;
  } catch (error) {
    console.error('Error loading subscription relays:', error);
    relaySelect.innerHTML = '<option value="">Error loading relays</option>';
  } finally {
    relaySelect.disabled = false;
  }
}

// Load subscription tiers for selected relay
async function loadSubscriptionTiers() {
  const relaySelect = document.getElementById('subscriptionRelaySelect');
  const selectedRelay = relaySelect.value;
  const tiersDiv = document.getElementById('subscriptionTiers');
  const tiersList = document.getElementById('tiersList');

  if (!selectedRelay) {
    tiersDiv.style.display = 'none';
    return;
  }

  const selectedOption = relaySelect.options[relaySelect.selectedIndex];
  const endpoint = selectedOption.dataset.endpoint;

  if (!endpoint) {
    showMessage('subscriptionMessage', 'error', 'Selected relay has no endpoint configured');
    return;
  }

  try {
    tiersList.innerHTML = '<div class="text-center text-[#A0A0A0] py-8"><div class="loading-spinner mb-4"></div><p>Loading tiers...</p></div>';
    tiersDiv.style.display = 'block';

    const response = await fetch(`${endpoint}/api/v1/x402/tiers`);
    if (!response.ok) {
      throw new Error(`Failed to load tiers: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success || !data.tiers) {
      throw new Error(data.error || 'No tiers available');
    }

    tiersList.innerHTML = data.tiers.map(tier => `
      <div class="tier-card ${tier.available ? '' : 'opacity-50'}" data-tier="${tier.id}">
        <div class="flex justify-between items-start mb-4">
          <h3 class="text-lg font-semibold text-[#FFFFFF] capitalize">${tier.id}</h3>
          ${tier.available ? '' : '<span class="text-[#F44336] text-xs">Unavailable</span>'}
        </div>
        <div class="tier-price mb-2">${tier.priceDisplay}</div>
        <div class="text-[#A0A0A0] text-sm mb-4">${tier.storageMB} MB storage</div>
        <ul class="text-[#A0A0A0] text-sm space-y-2 mb-4">
          <li>${tier.storageMB} MB included</li>
          <li>30 days duration</li>
          <li>IPFS pinning</li>
          <li>Auto-renewal available</li>
        </ul>
        ${tier.available ? `
          <button onclick="subscribeToRelay('${tier.id}', '${endpoint}')" 
                  class="btn bg-[#42A5F5] hover:bg-[#1976D2] border-0 text-white w-full">
            Subscribe
          </button>
        ` : `
          <button disabled class="btn bg-[#404040] text-[#606060] w-full cursor-not-allowed">
            ${tier.unavailableReason || 'Unavailable'}
          </button>
        `}
      </div>
    `).join('');

    // Load subscription status for this relay
    await loadSubscriptionStatus(endpoint);
    
    // Load uploaded files if subscription is active
    await loadSubscriptionFiles(endpoint);
  } catch (error) {
    console.error('Error loading tiers:', error);
    tiersList.innerHTML = `<div class="text-center text-[#F44336] py-8">Error: ${error.message}</div>`;
    showMessage('subscriptionMessage', 'error', `Failed to load tiers: ${error.message}`);
  }
}

// Load subscription status
async function loadSubscriptionStatus(relayEndpoint = null) {
  if (!connectedAddress) return;

  const statusDiv = document.getElementById('subscriptionStatus');
  const statusContent = document.getElementById('subscriptionStatusContent');

  if (!relayEndpoint) {
    const relaySelect = document.getElementById('subscriptionRelaySelect');
    if (!relaySelect || !relaySelect.value) {
      statusDiv.style.display = 'none';
      return;
    }
    const selectedOption = relaySelect.options[relaySelect.selectedIndex];
    relayEndpoint = selectedOption.dataset.endpoint;
  }

  if (!relayEndpoint) {
    statusDiv.style.display = 'none';
    return;
  }

  try {
    statusContent.innerHTML = '<div class="loading-spinner"></div>';
    statusDiv.style.display = 'block';

    const response = await fetch(`${relayEndpoint}/api/v1/x402/subscription/${connectedAddress}`);
    if (!response.ok) {
      throw new Error(`Failed to load status: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to load subscription status');
    }

    const sub = data.subscription;
    if (sub && sub.active) {
      const expiresAt = new Date(sub.expiresAt);
      const remainingMB = sub.storageRemainingMB || 0;
      statusContent.innerHTML = `
        <div class="space-y-2">
          <div class="flex items-center gap-2">
            <span class="text-[#4CAF50]">✓</span>
            <span class="text-[#FFFFFF] font-medium">Active Subscription</span>
          </div>
          <div class="text-[#A0A0A0] text-sm">
            <div>Tier: <span class="text-[#FFFFFF] capitalize">${sub.tier}</span></div>
            <div>Storage: <span class="text-[#FFFFFF]">${sub.storageMB} MB</span> (${remainingMB.toFixed(2)} MB remaining)</div>
            <div>Expires: <span class="text-[#FFFFFF]">${expiresAt.toLocaleDateString()}</span></div>
          </div>
        </div>
      `;
      
      // Show files section if subscription is active
      document.getElementById('subscriptionFilesSection').style.display = 'block';
      await loadSubscriptionFiles(relayEndpoint);
    } else {
      statusContent.innerHTML = `
        <div class="text-[#A0A0A0] text-sm">
          No active subscription. Select a tier below to subscribe.
        </div>
      `;
      document.getElementById('subscriptionFilesSection').style.display = 'none';
    }
  } catch (error) {
    console.error('Error loading subscription status:', error);
    statusContent.innerHTML = `<div class="text-[#F44336] text-sm">Error: ${error.message}</div>`;
  }
}

// Subscribe to a relay
async function subscribeToRelay(tier, relayEndpoint) {
  if (!connectedAddress || !signer) {
    showMessage('subscriptionMessage', 'error', 'Please connect your wallet first');
    return;
  }

  try {
    showMessage('subscriptionMessage', 'info', `Subscribing to ${tier} tier...`);

    // Step 1: Get payment requirements
    const requirementsResponse = await fetch(`${relayEndpoint}/api/v1/x402/payment-requirements/${tier}`);
    if (!requirementsResponse.ok) {
      throw new Error(`Failed to get payment requirements: ${requirementsResponse.status}`);
    }

    const requirementsData = await requirementsResponse.json();
    if (!requirementsData.success || !requirementsData.x402) {
      throw new Error(requirementsData.error || 'No payment requirements available');
    }

    const x402Req = requirementsData.x402;
    
    // Extract payment requirements from x402 response
    // x402 format: { x402Version, accepts: [{ scheme, network, maxAmountRequired, payTo, asset, extra }] }
    const accept = x402Req.accepts && x402Req.accepts[0] ? x402Req.accepts[0] : {};

    // Step 2: Create x402 payment authorization
    // x402 uses EIP-3009 transferWithAuthorization for USDC
    // This requires EIP-712 typed data signing
    showMessage('subscriptionMessage', 'info', 'Creating payment authorization...');

    // Get the payment requirement details from accepts array
    const payToAddress = accept.payTo || accept.payToAddress;
    const amountAtomic = accept.maxAmountRequired || accept.amount;
    const tokenAddress = accept.asset || accept.tokenAddress;
    const network = accept.network || x402Req.network || 'base-sepolia';
    
    // Generate nonce (use timestamp + random for uniqueness)
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    
    // Set validity window (5 minutes from now, valid for 10 minutes)
    const now = Math.floor(Date.now() / 1000);
    const validAfter = now;
    const validBefore = now + 600; // 10 minutes
    
    // Create authorization object matching EIP-3009 transferWithAuthorization
    const authorization = {
      from: connectedAddress,
      to: payToAddress,
      value: amountAtomic.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce: nonce,
    };

    // Step 3: Sign using EIP-712 (for USDC transferWithAuthorization)
    showMessage('subscriptionMessage', 'info', 'Please sign the payment authorization in your wallet...');
    
    // EIP-712 domain for USDC
    const domain = {
      name: accept.extra?.name || 'USD Coin',
      version: accept.extra?.version || '2',
      chainId: currentChainId,
      verifyingContract: tokenAddress,
    };
    
    // EIP-712 types for TransferWithAuthorization
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };
    
    // Sign the typed data
    const signature = await signer.signTypedData(domain, types, authorization);
    
    // Create payment payload
    const payment = {
      x402Version: x402Req.x402Version || 1,
      scheme: accept.scheme || 'exact',
      network: network,
      payload: {
        authorization: authorization,
        signature: signature,
      },
    };

    // Step 4: Submit subscription
    showMessage('subscriptionMessage', 'info', 'Submitting subscription...');
    const subscribeResponse = await fetch(`${relayEndpoint}/api/v1/x402/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userAddress: connectedAddress,
        tier: tier,
        payment: payment,
      }),
    });

    if (!subscribeResponse.ok) {
      const errorData = await subscribeResponse.json().catch(() => ({}));
      throw new Error(errorData.error || `Subscription failed: ${subscribeResponse.status}`);
    }

    const subscribeData = await subscribeResponse.json();
    if (!subscribeData.success) {
      throw new Error(subscribeData.error || 'Subscription failed');
    }

    showMessage('subscriptionMessage', 'success', 
      `Subscription activated! Expires: ${new Date(subscribeData.subscription.expiresAt).toLocaleDateString()}`
    );

    // Reload status
    await loadSubscriptionStatus(relayEndpoint);
  } catch (error) {
    console.error('Subscription error:', error);
    showMessage('subscriptionMessage', 'error', `Subscription failed: ${error.message}`);
  }
}

// Load subscription files
async function loadSubscriptionFiles(relayEndpoint) {
  if (!connectedAddress || !relayEndpoint) return;

  const filesList = document.getElementById('subscriptionFilesList');
  if (!filesList) return;

  try {
    filesList.innerHTML = '<div class="text-center text-[#A0A0A0] py-4"><div class="loading-spinner mb-2"></div><p>Loading files...</p></div>';

    const response = await fetch(`${relayEndpoint}/api/v1/user-uploads/${connectedAddress}`);
    if (!response.ok) {
      throw new Error(`Failed to load files: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to load files');
    }

    const uploads = data.uploads || [];
    
    if (uploads.length === 0) {
      filesList.innerHTML = `
        <div class="text-center text-[#A0A0A0] py-8">
          <p>No files uploaded yet</p>
          <p class="text-sm mt-2">Upload your first file using the form above</p>
        </div>
      `;
      return;
    }

    filesList.innerHTML = uploads.map(file => `
      <div class="p-4 bg-[#1A1A1A] rounded-lg border border-[#404040]">
        <div class="flex items-start justify-between mb-2">
          <div class="flex-1">
            <div class="text-[#FFFFFF] font-medium mb-1">${file.name || file.fileName || 'Unknown'}</div>
            <div class="text-[#606060] text-xs font-mono break-all mb-2">${file.hash || file.cid || 'N/A'}</div>
            <div class="flex gap-4 text-xs text-[#A0A0A0]">
              <span>Size: ${(file.sizeMB || file.size / (1024 * 1024)).toFixed(2)} MB</span>
              <span>Uploaded: ${new Date(file.uploadedAt || file.timestamp).toLocaleDateString()}</span>
            </div>
          </div>
          <div class="flex gap-2 ml-4">
            <button onclick="viewSubscriptionFile('${file.hash || file.cid}', '${relayEndpoint}', '${connectedAddress}')" 
               class="btn btn-sm bg-[#42A5F5] hover:bg-[#1976D2] border-0 text-white text-xs px-3 py-1">
              View
            </button>
            <button onclick="downloadSubscriptionFile('${file.hash || file.cid}', '${relayEndpoint}', '${connectedAddress}', '${file.name || file.fileName || file.hash}')" 
               class="btn btn-sm bg-[#4CAF50] hover:bg-[#388E3C] border-0 text-white text-xs px-3 py-1">
              Download
            </button>
            <button onclick="deleteSubscriptionFile('${file.hash || file.cid}', '${relayEndpoint}')" 
                    class="btn btn-sm bg-[#F44336] hover:bg-[#D32F2F] border-0 text-white text-xs px-3 py-1">
              Delete
            </button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading subscription files:', error);
    filesList.innerHTML = `
      <div class="text-center text-[#F44336] py-4">
        Error loading files: ${error.message}
      </div>
    `;
  }
}

// Upload file for subscription
async function uploadSubscriptionFile() {
  if (!connectedAddress || !signer) {
    showMessage('subscriptionMessage', 'error', 'Please connect your wallet first');
    return;
  }

  const fileInput = document.getElementById('subscriptionFileInput');
  const uploadBtn = document.getElementById('uploadSubscriptionBtn');
  const statusEl = document.getElementById('subscriptionUploadStatus');
  const relaySelect = document.getElementById('subscriptionRelaySelect');
  
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    showMessage('subscriptionMessage', 'error', 'Please select a file to upload');
    return;
  }

  const selectedOption = relaySelect.options[relaySelect.selectedIndex];
  const relayEndpoint = selectedOption.dataset.endpoint;
  
  if (!relayEndpoint) {
    showMessage('subscriptionMessage', 'error', 'Please select a relay first');
    return;
  }

  const file = fileInput.files[0];
  
  // Check if encryption is enabled
  const encryptionCheckbox = document.getElementById('subscriptionEncryptionEnabled');
  const encryptionEnabled = encryptionCheckbox ? encryptionCheckbox.checked : false;
  
  // Encrypt file using SEA if keypair is available and encryption is enabled
  let fileToUpload = file;
  let isEncrypted = false;
  let encryptionMetadata = null;
  
  statusEl.style.display = 'block';
  if (encryptionEnabled) {
    statusEl.textContent = `Encrypting and uploading ${file.name}...`;
  } else {
    statusEl.textContent = `Uploading ${file.name} as public file...`;
  }
  statusEl.style.color = '#42A5F5';
  
  if (encryptionEnabled && gunKeypair && window.Gun && window.Gun.SEA) {
    try {
      statusEl.textContent = `Encrypting ${file.name}...`;
      statusEl.style.color = '#42A5F5';
      
      // Request signature for encryption (more secure than using address directly)
      statusEl.textContent = `Requesting signature for encryption...`;
      showMessage('subscriptionMessage', 'info', 'Please sign the message in your wallet to encrypt the file...');
      
      // Create a deterministic message for encryption
      // Same message for all files from this user, allows deterministic key derivation
      const encryptionMessage = 'I Love Shogun';
      
      // Request signature from user
      const signature = await signer.signMessage(encryptionMessage);
      
      // Verify signature (sanity check)
      const recoveredAddress = ethers.verifyMessage(encryptionMessage, signature);
      if (recoveredAddress.toLowerCase() !== connectedAddress.toLowerCase()) {
        throw new Error('Signature verification failed');
      }
      
      statusEl.textContent = `Encrypting ${file.name}...`;
      
      // Convert file to data URL (same approach as deal files)
      const base64data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (err) => reject(err);
        reader.readAsDataURL(file);
      });
      
      // Encrypt using SEA with signature as token (same as deal files - encrypts the full data URL)
      const encrypted = await window.Gun.SEA.encrypt(base64data, signature);
      
      // Stringify the encrypted object to JSON before creating the File
      // This ensures it's saved as valid JSON on IPFS, not as "[object Object]"
      const encryptedString = JSON.stringify(encrypted);
      
      // Create encrypted file with .enc extension and text/plain type (same as upload.html and deal files)
      const baseFileName = file.name;
      const encryptionFileName = baseFileName.endsWith(".enc")
        ? baseFileName
        : `${baseFileName}.enc`;
      
      fileToUpload = new File([encryptedString], encryptionFileName, {
        type: "text/plain",
      });
      
      // Store encryption metadata for decryption later
      encryptionMetadata = {
        method: 'SEA',
        originalName: file.name,
        originalType: file.type,
        originalSize: file.size,
      };
      
      isEncrypted = true;
      console.log('✅ Subscription file encrypted with SEA');
    } catch (encryptError) {
      console.error('❌ Encryption failed:', encryptError);
      showMessage('subscriptionMessage', 'warning', 
        'File encryption failed. Uploading unencrypted file. ' + encryptError.message
      );
      // Continue with unencrypted upload
    }
  }
  
  const formData = new FormData();
  formData.append('file', fileToUpload);
  
  // Add encryption metadata if file is encrypted
  if (isEncrypted && encryptionMetadata) {
    formData.append('encrypted', 'true');
    formData.append('encryptionMethod', 'SEA');
    formData.append('encryptionMetadata', JSON.stringify(encryptionMetadata));
  } else {
    formData.append('encrypted', 'false');
    formData.append('public', 'true');
  }

  try {
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';
    statusEl.style.display = 'block';
    statusEl.textContent = isEncrypted 
      ? `Uploading encrypted ${file.name} to IPFS...`
      : 'Uploading file to IPFS...';
    statusEl.style.color = '#42A5F5';

    // Upload to relay's IPFS endpoint
    const response = await fetch(`${relayEndpoint}/api/v1/ipfs/upload`, {
      method: 'POST',
      body: formData,
      headers: {
        'x-user-address': connectedAddress
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Upload failed: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Upload failed');
    }

    if (isEncrypted) {
      statusEl.textContent = `✅ Encrypted file uploaded successfully! CID: ${data.cid || data.hash}`;
      showMessage('subscriptionMessage', 'success', `Encrypted file uploaded successfully: ${data.cid || data.hash}`);
    } else {
      statusEl.textContent = `✅ Public file uploaded successfully! CID: ${data.cid || data.hash}`;
      showMessage('subscriptionMessage', 'success', `Public file uploaded successfully: ${data.cid || data.hash}`);
    }
    statusEl.style.color = '#4CAF50';

    // Clear file input
    fileInput.value = '';

    // Reload files list
    await loadSubscriptionFiles(relayEndpoint);
  } catch (error) {
    console.error('Upload error:', error);
    statusEl.textContent = `Error: ${error.message}`;
    statusEl.style.color = '#F44336';
    showMessage('subscriptionMessage', 'error', `Upload failed: ${error.message}`);
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload to IPFS';
  }
}

// Delete subscription file
/**
 * Derives a GunDB keypair from an EVM signature
 * Uses shogun-core's derive function for deterministic keypair generation
 * 
 * @param {string} address - Ethereum address
 * @param {string} message - Message that was signed
 * @param {string} signature - EIP-191 signature
 * @returns {Promise<{pub: string, priv: string, epub: string, epriv: string}>}
 */
async function deriveKeypairFromSignature(address, message, signature) {
  // Verify signature first
  const recoveredAddress = ethers.verifyMessage(message, signature);
  if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
    throw new Error('Signature verification failed - address mismatch');
  }

  // Use the same salt format as shogun-core's deriveNostrKeys
  const salt = `${address}_${message}`;
  
  // Try to load shogun-core derive function
  // Option 1: If shogun-core is available as a global (loaded via script tag)
  if (window.ShogunCore && window.ShogunCore.derive) {
    const keypair = await window.ShogunCore.derive(address, salt, {
      includeP256: true,
      includeSecp256k1Ethereum: false,
      includeSecp256k1Bitcoin: false,
    });
    
    return {
      pub: keypair.pub,
      priv: keypair.priv,
      epub: keypair.epub,
      epriv: keypair.epriv,
    };
  }
  
  // Option 2: Try dynamic import (requires shogun-core to be built and accessible)
  try {
    // Adjust path based on your setup - could be relative or from a CDN
    const shogunCore = await import('https://cdn.jsdelivr.net/npm/shogun-core@6.5.5/dist/browser/shogun-core.js');
    if (shogunCore.derive) {
      const keypair = await shogunCore.derive(address, salt, {
        includeP256: true,
        includeSecp256k1Ethereum: false,
        includeSecp256k1Bitcoin: false,
      });
      
      return {
        pub: keypair.pub,
        priv: keypair.priv,
        epub: keypair.epub,
        epriv: keypair.epriv,
      };
    }
  } catch (importError) {
    console.warn('Could not import shogun-core:', importError);
  }
  
  // If shogun-core is not available, throw an error
  // In production, you should either:
  // 1. Load shogun-core bundle via script tag in index.html
  // 2. Bundle shogun-core with your app
  // 3. Use a CDN to serve shogun-core
  throw new Error(
    'shogun-core is required for key derivation. ' +
    'Please load shogun-core bundle (dist/browser/shogun-core.js) before using this function.'
  );
}

// View subscription file - handles decryption if needed
async function viewSubscriptionFile(fileHash, relayEndpoint, userAddress) {
  if (!fileHash || !relayEndpoint || !userAddress) {
    showMessage('subscriptionMessage', 'error', 'Missing required parameters');
    return;
  }

  try {
    showMessage('subscriptionMessage', 'info', 'Loading file...');
    
    // For subscription files, try decrypt endpoint first if we have connectedAddress (same approach as deal files)
    // The decrypt endpoint will handle non-encrypted files transparently
    let fileUrl;
    let response;
    
    // Always try to decrypt if we have signer (even if file might not be encrypted)
    if (connectedAddress && signer) {
      // Request signature for decryption (same message as encryption)
      const decryptionMessage = 'I Love Shogun';
      showMessage('subscriptionMessage', 'info', 'Please sign the message in your wallet to decrypt the file...');
      
      try {
        const signature = await signer.signMessage(decryptionMessage);
        
        // Use cat decrypt endpoint directly (hash is the CID for subscription files)
        fileUrl = `${relayEndpoint}/api/v1/ipfs/cat/${fileHash}/decrypt?token=${encodeURIComponent(signature)}`;
        console.log('🔓 Using cat decrypt endpoint with signature');
        
        response = await fetch(fileUrl, {
          headers: {
            'x-user-address': connectedAddress,
          },
        });
        
        if (!response.ok) {
          throw new Error(`Decryption failed: ${response.status}`);
        }
      } catch (signError) {
        if (signError.message && signError.message.includes('User rejected')) {
          showMessage('subscriptionMessage', 'error', 'Signature rejected. Cannot decrypt file.');
          return;
        }
        throw signError;
      }
    } else {
      // No signer available, try regular endpoint
      fileUrl = `${relayEndpoint}/api/v1/ipfs/user-uploads/${userAddress}/${fileHash}/view`;
      response = await fetch(fileUrl);
    }
    
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status}`);
    }
    
    // If using decrypt endpoint, server has already decrypted the file
    // Just get it as blob and open it
    const blob = await response.blob();
    
    // Create blob URL and open in new tab
    const url = window.URL.createObjectURL(blob);
    window.open(url, '_blank');
    
    // Clean up after a delay
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    
    showMessage('subscriptionMessage', 'success', 'File opened in new tab');
  } catch (error) {
    console.error('Error viewing subscription file:', error);
    showMessage('subscriptionMessage', 'error', `Failed to view file: ${error.message}`);
  }
}

// Download subscription file - handles decryption if needed
async function downloadSubscriptionFile(fileHash, relayEndpoint, userAddress, filename) {
  if (!fileHash || !relayEndpoint || !userAddress) {
    showMessage('subscriptionMessage', 'error', 'Missing required parameters');
    return;
  }

  try {
    showMessage('subscriptionMessage', 'info', 'Downloading file...');
    
    // For subscription files, use decrypt endpoint if we have connectedAddress (same approach as deal files)
    // The hash is the CID, so we can use /cat/:cid/decrypt endpoint
    let fileUrl;
    let response;
    
    if (connectedAddress && signer) {
      // Request signature and use decrypt endpoint
      const decryptionMessage = 'I Love Shogun';
      showMessage('subscriptionMessage', 'info', 'Please sign the message in your wallet...');
      
      const signature = await signer.signMessage(decryptionMessage);
      // Use cat decrypt endpoint directly (hash is the CID for subscription files)
      fileUrl = `${relayEndpoint}/api/v1/ipfs/cat/${fileHash}/decrypt?token=${encodeURIComponent(signature)}`;
      response = await fetch(fileUrl, {
        headers: { 'x-user-address': connectedAddress },
      });
    } else {
      // No token available, use regular download endpoint
      fileUrl = `${relayEndpoint}/api/v1/ipfs/user-uploads/${userAddress}/${fileHash}/download`;
      response = await fetch(fileUrl);
    }
    
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }
    
    // If using decrypt endpoint, server has already decrypted the file
    // Just get it as blob
    const blob = await response.blob();
    
    // Determine filename
    let downloadFilename = filename || fileHash;
    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
    
    // Add extension based on content type
    if (contentType.startsWith('image/')) {
      downloadFilename += '.' + contentType.split('/')[1].split(';')[0];
    } else if (contentType === 'text/plain') {
      downloadFilename += '.txt';
    }
    
    // Create download link
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    showMessage('subscriptionMessage', 'success', 'File downloaded successfully');
  } catch (error) {
    console.error('Error downloading subscription file:', error);
    showMessage('subscriptionMessage', 'error', `Download failed: ${error.message}`);
  }
}

async function deleteSubscriptionFile(fileHash, relayEndpoint) {
  if (!connectedAddress) {
    showMessage('subscriptionMessage', 'error', 'Please connect your wallet first');
    return;
  }

  if (!confirm(`Are you sure you want to delete this file? This action cannot be undone.`)) {
    return;
  }

  try {
    showMessage('subscriptionMessage', 'info', 'Deleting file...');

    const response = await fetch(`${relayEndpoint}/api/v1/user-uploads/${connectedAddress}/${fileHash}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Delete failed: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Delete failed');
    }

    showMessage('subscriptionMessage', 'success', 'File deleted successfully');
    
    // Reload files list
    await loadSubscriptionFiles(relayEndpoint);
  } catch (error) {
    console.error('Delete error:', error);
    showMessage('subscriptionMessage', 'error', `Delete failed: ${error.message}`);
  }
}

/**
 * View deal file - downloads encrypted file and decrypts client-side
 * Falls back to ipfs.io if relay endpoint is not available
 */
async function viewDealFile(cid, relayEndpoint) {
  if (!cid) {
    showMessage('createMessage', 'error', 'No CID provided');
    return;
  }

  try {
    showMessage('createMessage', 'info', 'Loading file...');
    
    // Try decrypt endpoint first if we have connectedAddress and signer
    // The decrypt endpoint will handle non-encrypted files transparently
    let fileUrl;
    let response;
    
    if (connectedAddress && signer && relayEndpoint && window.Gun && window.Gun.SEA) {
      // Request signature for decryption (same message as encryption)
      const decryptionMessage = 'I Love Shogun';
      showMessage('createMessage', 'info', 'Please sign the message in your wallet to decrypt the file...');
      
      try {
        const signature = await signer.signMessage(decryptionMessage);
        
        // Verify signature (sanity check)
        const recoveredAddress = ethers.verifyMessage(decryptionMessage, signature);
        if (recoveredAddress.toLowerCase() !== connectedAddress.toLowerCase()) {
          throw new Error('Signature verification failed');
        }
        
        // Try decrypt endpoint with signature
        fileUrl = `${relayEndpoint}/api/v1/ipfs/cat/${cid}/decrypt?token=${encodeURIComponent(signature)}`;
        console.log('🔓 Trying decrypt endpoint for file with signature');
        
        response = await fetch(fileUrl, {
          headers: {
            'x-user-address': connectedAddress, // For server-side signature verification
          },
        });
        
        // If decrypt endpoint fails, try regular endpoint as fallback
        if (!response.ok && response.status === 400) {
          console.log('⚠️ Decrypt endpoint failed, trying regular endpoint');
          fileUrl = `${relayEndpoint}/api/v1/ipfs/cat/${cid}`;
          response = await fetch(fileUrl);
        }
      } catch (signError) {
        if (signError.message && signError.message.includes('User rejected')) {
          showMessage('createMessage', 'error', 'Signature rejected. Cannot decrypt file.');
          return;
        }
        // On other errors, try regular endpoint
        console.log('⚠️ Signature error, trying regular endpoint:', signError);
        fileUrl = `${relayEndpoint}/api/v1/ipfs/cat/${cid}`;
        response = await fetch(fileUrl);
      }
    } else if (relayEndpoint) {
      fileUrl = `${relayEndpoint}/api/v1/ipfs/cat/${cid}`;
      response = await fetch(fileUrl);
    } else {
      fileUrl = `https://ipfs.io/ipfs/${cid}`;
      response = await fetch(fileUrl);
    }
    
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status}`);
    }
    
    // If using decrypt endpoint, server has already decrypted the file
    // Just get it as blob and open it
    const blob = await response.blob();
    
    // Create blob URL and open in new tab
    const url = window.URL.createObjectURL(blob);
    window.open(url, '_blank');
    
    // Clean up after a delay (browser will keep it for the tab)
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    
    showMessage('createMessage', 'success', 'File opened in new tab');
  } catch (error) {
    console.error('Error viewing file:', error);
    showMessage('createMessage', 'error', `Failed to view file: ${error.message}`);
  }
}

/**
 * Download deal file - downloads encrypted file and decrypts client-side
 * Falls back to ipfs.io if relay endpoint is not available
 */
async function downloadDealFile(cid, relayEndpoint, dealId) {
  if (!cid) {
    showMessage('createMessage', 'error', 'No CID provided');
    return;
  }

  try {
    showMessage('createMessage', 'info', 'Downloading file...');
    
    // Try decrypt endpoint first if we have connectedAddress and signer
    // The decrypt endpoint will handle non-encrypted files transparently
    let fileUrl;
    let response;
    
    if (connectedAddress && signer && relayEndpoint && window.Gun && window.Gun.SEA) {
      // Request signature for decryption (same message as encryption)
      const decryptionMessage = 'I Love Shogun';
      showMessage('createMessage', 'info', 'Please sign the message in your wallet to decrypt the file...');
      
      try {
        const signature = await signer.signMessage(decryptionMessage);
        
        // Verify signature (sanity check)
        const recoveredAddress = ethers.verifyMessage(decryptionMessage, signature);
        if (recoveredAddress.toLowerCase() !== connectedAddress.toLowerCase()) {
          throw new Error('Signature verification failed');
        }
        
        // Try decrypt endpoint with signature
        fileUrl = `${relayEndpoint}/api/v1/ipfs/cat/${cid}/decrypt?token=${encodeURIComponent(signature)}`;
        console.log('🔓 Trying decrypt endpoint for file with signature');
        
        response = await fetch(fileUrl, {
          headers: {
            'x-user-address': connectedAddress, // For server-side signature verification
          },
        });
        
        // If decrypt endpoint fails, try regular endpoint as fallback
        if (!response.ok && response.status === 400) {
          console.log('⚠️ Decrypt endpoint failed, trying regular endpoint');
          fileUrl = `${relayEndpoint}/api/v1/ipfs/cat/${cid}`;
          response = await fetch(fileUrl);
        }
      } catch (signError) {
        if (signError.message && signError.message.includes('User rejected')) {
          showMessage('createMessage', 'error', 'Signature rejected. Cannot decrypt file.');
          return;
        }
        // On other errors, try regular endpoint
        console.log('⚠️ Signature error, trying regular endpoint:', signError);
        fileUrl = `${relayEndpoint}/api/v1/ipfs/cat/${cid}`;
        response = await fetch(fileUrl);
      }
    } else if (relayEndpoint) {
      fileUrl = `${relayEndpoint}/api/v1/ipfs/cat/${cid}`;
      response = await fetch(fileUrl);
    } else {
      fileUrl = `https://ipfs.io/ipfs/${cid}`;
      response = await fetch(fileUrl);
    }
    
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }
    
    // If using decrypt endpoint, server has already decrypted the file
    // Just get it as blob
    const blob = await response.blob();
    
    // Determine filename
    let filename = `deal-${dealId.substring(0, 10)}-${cid.substring(0, 10)}`;
    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
    
    // Add extension based on content type
    if (contentType.startsWith('image/')) {
      filename += '.' + contentType.split('/')[1].split(';')[0];
    } else if (contentType === 'text/plain') {
      filename += '.txt';
    }
    
    // Create download link
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    showMessage('createMessage', 'success', 'File downloaded successfully');
  } catch (error) {
    console.error('Error downloading file:', error);
    showMessage('createMessage', 'error', `Download failed: ${error.message}`);
  }
}

// =========================================== User Registration ===========================================

/**
 * Load registration status and update UI
 */
async function loadRegistrationStatus() {
  if (!connectedAddress || !relayRegistry) {
    return;
  }

  const statusDiv = document.getElementById('registrationStatus');
  const statusContent = document.getElementById('registrationStatusContent');
  const keypairStatusContent = document.getElementById('keypairStatusContent');
  const registerBtn = document.getElementById('registerUserBtn');
  const updateKeysBtn = document.getElementById('updateKeysBtn');
  const depositStakeBtn = document.getElementById('depositStakeBtn');

  try {
    // First, check if address is registered as a relay
    let isRelay = false;
    let relayInfo = null;
    try {
      relayInfo = await relayRegistry.getRelayInfo(connectedAddress);
      // If getRelayInfo succeeds and has endpoint, it's a relay
      isRelay = relayInfo.endpoint && relayInfo.endpoint.length > 0;
    } catch (relayError) {
      // If getRelayInfo fails, it's not a relay (or not registered at all)
      isRelay = false;
    }

    if (isRelay) {
      // Relay can also deposit stake as a user (for better griefing ratio)
      // Check if also registered as user
      let isAlsoUser = false;
      let userStake = 0n;
      try {
        const userInfo = await relayRegistry.getUserInfo(connectedAddress);
        isAlsoUser = userInfo.registeredAt > 0n;
        if (isAlsoUser) {
          userStake = userInfo.stakedAmount || 0n;
        }
      } catch (userError) {
        isAlsoUser = false;
      }

      statusDiv.style.display = 'block';
      if (isAlsoUser) {
        // This should never happen - relay cannot be user according to contract
        statusContent.innerHTML = `
          <div class="text-[#FF9800] mb-2">⚠️ You are registered as a Relay</div>
          <div class="text-sm space-y-1">
            <div>Relay Stake: ${ethers.formatUnits(relayInfo.stakedAmount || 0n, 6)} USDC</div>
          </div>
          <p class="text-sm mt-2 text-[#F44336]">⚠️ Note: Relays cannot register as users or deposit user stake. Use a different wallet address if you want to register as a user.</p>
        `;
        depositStakeBtn.disabled = true;
        registerBtn.disabled = true; // Relays cannot register as users
      } else {
        statusContent.innerHTML = `
          <div class="text-[#FF9800] mb-2">⚠️ You are registered as a Relay</div>
          <div class="text-sm space-y-1">
            <div>Relay Stake: ${ethers.formatUnits(relayInfo.stakedAmount || 0n, 6)} USDC</div>
          </div>
          <p class="text-sm mt-2 text-[#F44336]">⚠️ <strong>Important:</strong> The contract does not allow relays to also be users. You cannot register as a user or deposit user stake from this wallet.</p>
          <p class="text-sm mt-1 text-[#606060]">If you want to deposit user stake, you must use a different wallet address that is not registered as a relay.</p>
        `;
        depositStakeBtn.disabled = true;
        registerBtn.disabled = true; // Relays cannot register as users - contract prevents this
      }
      updateKeysBtn.disabled = false; // Allow updating keys
      
      // Update keypair status
      if (gunKeypair) {
        keypairStatusContent.innerHTML = `
          <div class="text-[#4CAF50] mb-2">✅ Keys Generated</div>
          <div class="text-xs space-y-1 font-mono break-all">
            <div>Pub: ${gunKeypair.pub.substring(0, 40)}...</div>
            <div>Epub: ${gunKeypair.epub.substring(0, 40)}...</div>
          </div>
        `;
      }
      
      // Don't return early if also user - continue to show user info
      if (isAlsoUser) {
        // Continue to show user registration details below
      } else {
        // If not also user, show message and return
        return;
      }
    }

    // Not a relay, try to get user info
    try {
      const userInfo = await relayRegistry.getUserInfo(connectedAddress);
      
      // User is registered
      if (userInfo.registeredAt > 0) {
        statusDiv.style.display = 'block';
        statusContent.innerHTML = `
          <div class="text-[#4CAF50] mb-2">✅ Registered</div>
          <div class="text-sm space-y-1">
            <div>Registered: ${new Date(Number(userInfo.registeredAt) * 1000).toLocaleDateString()}</div>
            <div>Stake: ${ethers.formatUnits(userInfo.stakedAmount, 6)} USDC</div>
            <div>Griefing Ratio: ${Number(userInfo.griefingRatio) / 100}%</div>
          </div>
        `;
        registerBtn.disabled = true;
        registerBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          Already Registered
        `;
        updateKeysBtn.disabled = false;
        depositStakeBtn.disabled = false;
        console.log('✅ Deposit stake button ENABLED (user registered, not relay)');
      } else {
        // User not registered (edge case - registeredAt is 0)
        statusDiv.style.display = 'block';
        statusContent.innerHTML = `
          <div class="text-[#FF9800] mb-2">⚠️ Not Registered</div>
          <p class="text-sm">Register to enable encrypted data exchange with other users.</p>
        `;
        registerBtn.disabled = gunKeypair ? false : true;
        updateKeysBtn.disabled = true;
        depositStakeBtn.disabled = true;
      }
    } catch (userError) {
      // getUserInfo failed - user is not registered
      // Check if it's a specific error or just not registered
      const errorData = userError.data || userError.reason || userError.message || '';
      const isUserNotRegisteredError = 
        errorData.includes('UserNotRegistered') || 
        errorData.includes('0x2163950f') ||
        userError.message.includes('UserNotRegistered') ||
        userError.message.includes('execution reverted');
      
      if (isUserNotRegisteredError || userError.code === 'CALL_EXCEPTION') {
        // User not registered
        statusDiv.style.display = 'block';
        statusContent.innerHTML = `
          <div class="text-[#FF9800] mb-2">⚠️ Not Registered</div>
          <p class="text-sm">Register to enable encrypted data exchange with other users.</p>
        `;
        registerBtn.disabled = gunKeypair ? false : true;
        updateKeysBtn.disabled = true;
        depositStakeBtn.disabled = true;
      } else {
        // Unexpected error
        console.error('Error loading user info:', userError);
        throw userError;
      }
    }

    // Update keypair status
    if (gunKeypair) {
      keypairStatusContent.innerHTML = `
        <div class="text-[#4CAF50] mb-2">✅ Keys Generated</div>
        <div class="text-xs space-y-1 font-mono break-all">
          <div>Pub: ${gunKeypair.pub.substring(0, 40)}...</div>
          <div>Epub: ${gunKeypair.epub.substring(0, 40)}...</div>
        </div>
      `;
    } else {
      keypairStatusContent.innerHTML = `
        <div class="text-[#FF9800] mb-2">⚠️ Keys Not Generated</div>
        <p class="text-xs">Generating encryption keys from your wallet...</p>
        <div class="flex items-center gap-2 mt-2">
          <div class="loading-spinner"></div>
          <span class="text-xs">Please wait...</span>
        </div>
      `;
      // Try to derive keypair
      try {
        await deriveGunKeypair();
        // Reload status after keypair is generated
        setTimeout(() => loadRegistrationStatus(), 1000);
      } catch (error) {
        keypairStatusContent.innerHTML = `
          <div class="text-[#F44336] mb-2">❌ Failed to Generate Keys</div>
          <p class="text-xs">Error: ${error.message}</p>
        `;
      }
    }
  } catch (error) {
    // Unexpected error
    console.error('Error loading registration status:', error);
    showMessage('registerMessage', 'error', `Failed to load registration status: ${error.message}`);
  }
}

/**
 * Register user to the protocol
 */
async function registerUser() {
  if (!connectedAddress || !signer || !relayRegistry) {
    showMessage('registerMessage', 'error', 'Please connect your wallet first');
    return;
  }

  if (!gunKeypair) {
    showMessage('registerMessage', 'error', 'Encryption keys not generated. Please wait...');
    // Try to derive keypair
    try {
      await deriveGunKeypair();
      if (!gunKeypair) {
        showMessage('registerMessage', 'error', 'Failed to generate encryption keys. Please refresh the page.');
        return;
      }
    } catch (error) {
      showMessage('registerMessage', 'error', `Failed to generate encryption keys: ${error.message}`);
      return;
    }
  }

  try {
    showMessage('registerMessage', 'info', 'Registering to protocol...');
    
    // Convert GunDB SEA keypair to bytes format
    // GunDB SEA keys are JSON strings, we need to convert them to bytes
    const pubkeyBytes = ethers.toUtf8Bytes(gunKeypair.pub);
    const epubBytes = ethers.toUtf8Bytes(gunKeypair.epub);

    console.log('📝 Registering user with keys:');
    console.log('  Pub:', gunKeypair.pub.substring(0, 40) + '...');
    console.log('  Epub:', gunKeypair.epub.substring(0, 40) + '...');

    // Call registerUser on the contract
    const tx = await relayRegistry.registerUser(pubkeyBytes, epubBytes);
    showMessage('registerMessage', 'info', 'Transaction submitted. Waiting for confirmation...');
    
    await tx.wait();
    showMessage('registerMessage', 'success', 'Successfully registered to Shogun Protocol!');
    
    // Reload registration status
    await loadRegistrationStatus();
  } catch (error) {
    console.error('Registration error:', error);
    
    if (error.message && error.message.includes('User rejected')) {
      showMessage('registerMessage', 'error', 'Transaction was rejected');
    } else if (error.message && error.message.includes('RelayAlreadyRegistered')) {
      showMessage('registerMessage', 'error', 'This address is already registered as a relay. Users cannot be relays.');
    } else {
      showMessage('registerMessage', 'error', `Registration failed: ${error.message}`);
    }
  }
}

/**
 * Update user encryption keys
 */
async function updateUserKeys() {
  if (!connectedAddress || !signer || !relayRegistry) {
    showMessage('registerMessage', 'error', 'Please connect your wallet first');
    return;
  }

  if (!gunKeypair) {
    showMessage('registerMessage', 'error', 'Encryption keys not generated. Please wait...');
    return;
  }

  try {
    showMessage('registerMessage', 'info', 'Updating encryption keys...');
    
    // Convert GunDB SEA keypair to bytes format
    const pubkeyBytes = ethers.toUtf8Bytes(gunKeypair.pub);
    const epubBytes = ethers.toUtf8Bytes(gunKeypair.epub);

    // Call updateUserKeys on the contract via SDK
    // SDK doesn't expose updateUserKeys directly, use contract method
    const tx = await relayRegistry.getContract().updateUserKeys(pubkeyBytes, epubBytes);
    showMessage('registerMessage', 'info', 'Transaction submitted. Waiting for confirmation...');
    
    await tx.wait();
    showMessage('registerMessage', 'success', 'Encryption keys updated successfully!');
    
    // Reload registration status
    await loadRegistrationStatus();
  } catch (error) {
    console.error('Update keys error:', error);
    
    if (error.message && error.message.includes('User rejected')) {
      showMessage('registerMessage', 'error', 'Transaction was rejected');
    } else {
      showMessage('registerMessage', 'error', `Failed to update keys: ${error.message}`);
    }
  }
}

/**
 * Deposit stake for user (optional)
 */
async function depositUserStake() {
  console.log('🔵 depositUserStake called - starting...');
  
  const depositStakeBtn = document.getElementById('depositStakeBtn');
  console.log('🔵 Button element:', depositStakeBtn);
  console.log('🔵 Button disabled?', depositStakeBtn?.disabled);
  
  if (depositStakeBtn && depositStakeBtn.disabled) {
    console.log('❌ Button is disabled - aborting');
    showMessage('registerMessage', 'error', 'Please register as a user first before depositing user stake. Relays need to register as users to deposit user stake.');
    return;
  }
  
  console.log('🔵 Checking required objects...');
  console.log('🔵 connectedAddress:', connectedAddress);
  console.log('🔵 signer:', !!signer);
  console.log('🔵 relayRegistry:', !!relayRegistry);
  console.log('🔵 usdc:', !!usdc);
  
  if (!connectedAddress || !signer || !relayRegistry || !usdc) {
    console.log('❌ Missing required objects:', { connectedAddress, signer: !!signer, relayRegistry: !!relayRegistry, usdc: !!usdc });
    showMessage('registerMessage', 'error', 'Please connect your wallet first');
    return;
  }
  
  console.log('✅ All required objects present');

  const amountInput = document.getElementById('userStakeAmount');
  if (!amountInput) {
    console.error('userStakeAmount input not found');
    showMessage('registerMessage', 'error', 'Stake amount input not found');
    return;
  }
  
  const amount = parseFloat(amountInput.value);
  console.log('🔵 Parsed amount:', amount);
  console.log('🔵 Amount input value:', amountInput.value);
  
  if (!amount || amount <= 0 || isNaN(amount)) {
    console.log('❌ Invalid amount:', amount);
    showMessage('registerMessage', 'error', 'Please enter a valid stake amount');
    return;
  }
  
  console.log('✅ Amount is valid:', amount);

  try {
    // Disable button during transaction
    if (depositStakeBtn) depositStakeBtn.disabled = true;
    
    showMessage('registerMessage', 'info', 'Depositing stake...');
    
    // Convert to USDC units (6 decimals)
    const amountWei = ethers.parseUnits(amount.toString(), 6);
    console.log('Amount to deposit:', amount, 'USDC =', amountWei.toString(), 'wei');
    
    // Check balance
    const balance = await usdc.balanceOf(connectedAddress);
    console.log('Current USDC balance:', ethers.formatUnits(balance, 6));
    if (balance < amountWei) {
      showMessage('registerMessage', 'error', `Insufficient USDC balance. You have ${ethers.formatUnits(balance, 6)} USDC`);
      if (depositStakeBtn) depositStakeBtn.disabled = false;
      return;
    }

    // Get relay registry address from SDK
    const relayRegistryAddress = relayRegistry.getAddress();
    console.log('Relay Registry address:', relayRegistryAddress);
    
    // Check allowance
    const allowance = await usdc.allowance(connectedAddress, relayRegistryAddress);
    console.log('Current allowance:', ethers.formatUnits(allowance, 6), 'USDC');
    if (allowance < amountWei) {
      showMessage('registerMessage', 'info', 'Approving USDC...');
      const approveTx = await usdc.approve(relayRegistryAddress, amountWei);
      console.log('Approve transaction:', approveTx.hash);
      await approveTx.wait();
      console.log('Approval confirmed');
    }

    // Deposit stake (griefingRatio = 0 means use default)
    console.log('Calling depositUserStake with amount:', amountWei.toString(), 'griefingRatio: 0');
    const tx = await relayRegistry.depositUserStake(amountWei, 0);
    console.log('Deposit transaction submitted:', tx.hash);
    showMessage('registerMessage', 'info', `Transaction submitted: ${tx.hash}. Waiting for confirmation...`);
    
    await tx.wait();
    console.log('Transaction confirmed');
    showMessage('registerMessage', 'success', `Successfully deposited ${amount} USDC stake!`);
    
    // Clear input
    amountInput.value = '';
    
    // Reload registration status
    await loadRegistrationStatus();
  } catch (error) {
    console.error('Deposit stake error:', error);
    
    // Re-enable button on error
    if (depositStakeBtn) depositStakeBtn.disabled = false;
    
    if (error.message && (error.message.includes('User rejected') || error.message.includes('user rejected'))) {
      showMessage('registerMessage', 'error', 'Transaction was rejected by user');
    } else if (error.reason) {
      showMessage('registerMessage', 'error', `Failed to deposit stake: ${error.reason}`);
    } else {
      showMessage('registerMessage', 'error', `Failed to deposit stake: ${error.message || JSON.stringify(error)}`);
    }
  }
}

// Export functions to window for HTML onclick handlers
// Since app.js is now an ES6 module, functions need to be explicitly exposed to global scope
window.changeNetwork = changeNetwork;
window.disconnectWallet = disconnectWallet;
window.showTab = showTab;
window.handleFileSelect = handleFileSelect;
window.uploadToIPFS = uploadToIPFS;
window.showRelayLeaderboard = showRelayLeaderboard;
window.loadAvailableRelays = loadAvailableRelays;
window.createDeal = createDeal;
window.loadMyDeals = loadMyDeals;
window.loadSubscriptionTiers = loadSubscriptionTiers;
window.uploadSubscriptionFile = uploadSubscriptionFile;
window.registerUser = registerUser;
window.depositUserStake = depositUserStake;
console.log('✅ depositUserStake exported to window:', typeof window.depositUserStake);
window.updateUserKeys = updateUserKeys;
window.subscribeToRelay = subscribeToRelay;
window.verifyDeal = verifyDeal;
window.viewDealFile = viewDealFile;
window.closeGriefModal = closeGriefModal;
window.submitGrief = submitGrief;
window.showGriefModal = showGriefModal;
window.completeDeal = completeDeal;
window.closeRelayLeaderboard = closeRelayLeaderboard;
window.selectRelayFromLeaderboard = selectRelayFromLeaderboard;
window.downloadDealFile = downloadDealFile;
window.viewSubscriptionFile = viewSubscriptionFile;
window.downloadSubscriptionFile = downloadSubscriptionFile;
window.deleteSubscriptionFile = deleteSubscriptionFile;
