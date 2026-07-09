# Blockchain Transaction Address Tracking & Forensic System

An AI-driven blockchain forensic suite designed to trace the flow of funds on the Ethereum Mainnet, classify address behaviors, and detect high-risk entities (such as phishing nodes or mixers). 

The platform combines **Recursive Multi-Hop Tracing** with the state-of-the-art **TEMPER AI Engine** (based on the KDD '25 architecture) to deliver real-time risk classification and transaction chain audits.

---

##  Key Features

*   **TEMPER AI Behavioral Classification (KDD '25):**
    *   **Parallel Temporal Encoder (PTE):** Uses LSTMs to track long-term wallet behaviors across 8 structural graph features.
    *   **SABES (Sudden Behavioral Shifts) Autoencoder:** Evaluates short-term anomalies using neighbor ratios and delta amounts. High reconstruction errors indicate sudden cash-out behaviors.
    *   **Co-Attention & Risk Scoring:** Correlates long and short-term metrics to generate a risk percentage and granular classification (`LOW`, `SUSPICIOUS`, or `CRITICAL`).
*   **Recursive Multi-Hop Tracing:**
    *   Automated chronological path tracing following outgoing funds step-by-step.
    *   Finds deposit addresses on centralized Virtual Asset Service Providers (VASPs), exchanges, or smart contracts.
*   **Secure API Architecture:**
    *   RPC commands and Alchemy APIs are proxied through a Node.js gateway, safeguarding API keys from client exposure.
*   **Glassmorphic Interactive UI:**
    *   Responsive dashboard with transition effects, micro-animations, and clean data visualizations.

---

## Repository Structure

```directory
├── new-final/
│   ├── ai_engine_v1/        # Python FastAPI server & PyTorch TEMPER model
│   │   ├── server.py        # API endpoint for risk prediction (/predict)
│   │   ├── temper_model.py  # Model layers (PTE, SABES, CoAttention, TEMPER)
│   │   └── requirements.txt # Python dependencies
│   │
│   ├── backend_v1/          # Node.js + Express backend gateway
│   │   ├── server.js        # Express routes, recursive tracing, Alchemy client
│   │   ├── db.js            # MongoDB collections, schemas, and indices
│   │   └── entities.json    # Off-chain entity lookup directory
│   │
│   └── frontend_v1/         # React + Vite client dashboard
│
├── frontend/                # Standalone React components
│   └── implement.jsx        # Glassmorphic React UI component
│
├── bc.js                    # Legacy Node CLI transaction tracking script
├── index.js                 # Minimal CLI transaction info fetcher
├── implement.html           # Standalone single-file HTML/JS tracker utility
└── .gitignore               # Configured git ignore definitions
```

---

##  Setup & Installation

### 1. Prerequisites
Ensure you have the following installed:
*   [Node.js](https://nodejs.org/) (v18+)
*   [Python](https://www.python.org/) (v3.9+)
*   [MongoDB](https://www.mongodb.com/) (Local or Atlas Instance)

---

### 2. Environment Configurations

#### Backend Environment (`new-final/backend_v1/.env`)
Create a `.env` file inside `new-final/backend_v1/` containing:
```env
# Ethereum RPC Node
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_API_KEY

# Database Configuration
MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/
MONGODB_DB=Transaction_Monitoring

# Express Port
PORT=5000
```

---

### 3. Running the AI Engine (`ai_engine_v1`)
1. Navigate to the AI engine folder:
   ```bash
   cd new-final/ai_engine_v1
   ```
2. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Start the FastAPI server:
   ```bash
   python server.py
   ```
   *The AI engine will run on `http://localhost:8000`.*

---

### 4. Running the Backend Gateway (`backend_v1`)
1. Navigate to the backend folder:
   ```bash
   cd new-final/backend_v1
   ```
2. Install Node packages:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   node server.js
   ```
   *The backend gateway will run on `http://localhost:5000`.*

---

### 5. Running the Frontend Dashboard (`frontend_v1`)
1. Navigate to the frontend folder:
   ```bash
   cd new-final/frontend_v1
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run Vite development server:
   ```bash
   npm run dev
   ```
   *Open `http://localhost:5173` in your browser.*

---

##  API Endpoints

### Gateway Backend (`Express`)
*   `GET /api/transaction/:hash` - Retrieve Ethereum transaction receipt details.
*   `GET /api/transfers/:address` - Get incoming/outgoing transfers for an address.
*   `POST /api/trace` - Execute recursive multi-hop path checks.

### AI engine (`FastAPI`)
*   `POST /predict` - Submits wallet metadata & transaction sequences to compute a TEMPER risk score.
*   `GET /health` - Checks engine status and model state.
