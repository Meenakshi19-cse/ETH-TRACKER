import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np

class STS:
    """
    Sequenced Transaction Sampling (STS)
    Tackles large-scale transaction networks while preserving temporal order.
    Algorithm 1 from the TEMPER paper.
    """
    @staticmethod
    def sample(np_list, p_list):
        # np_list: List of normal transactions (temporally sorted)
        # p_list: List of phishing transactions (temporally sorted)
        n = len(np_list)
        p = len(p_list)
        if p == 0: return [np_list]
        
        merged_list = []
        num_blocks = int(np.ceil(n / p))
        
        for i in range(num_blocks):
            # p_block = P[0 : p]
            # np_block = NP[i*p : (i+1)*p]
            p_block = p_list
            start = i * p
            end = min((i + 1) * p, n)
            np_block = np_list[start:end]
            
            combined = p_block + np_block
            # Sort by date (assuming objects have 'timestamp')
            combined.sort(key=lambda x: x.get('timestamp', 0))
            merged_list.append(combined)
            
        return merged_list

class PTE(nn.Module):
    """
    Parallel Temporal Encoder (PTE)
    Captures smooth, long-term transaction behaviors using multiple parallel LSTM layers.
    Uses 8 basic transaction features.
    """
    def __init__(self, input_dim=8, hidden_dim=64, num_parallel=3):
        super(PTE, self).__init__()
        # As per paper 4.2: 3 parallel LSTM layers with 128 neurons
        self.parallel_lstms = nn.ModuleList([
            nn.LSTM(input_dim, 128, batch_first=True) for _ in range(num_parallel)
        ])
        # Projection to final embedding dimension d
        self.fc = nn.Linear(128 * num_parallel, hidden_dim)
        
    def forward(self, x):
        # x: (batch_size, seq_len, 8)
        list_h = []
        for lstm in self.parallel_lstms:
            out, (h_n, c_n) = lstm(x)
            list_h.append(h_n[-1]) # Last hidden state
            
        # Concatenate hidden states from parallel layers
        combined_h = torch.cat(list_h, dim=-1)
        z_pte = self.fc(combined_h)
        return z_pte

class SABES(nn.Module):
    """
    Sequential leArning from sudden BEhavioral Shifts (SABES)
    Captures short-term abrupt fluctuations using a Temporal Autoencoder.
    Uses 2 specific features: Delta Amount and Neighbor Ratio.
    """
    def __init__(self, input_dim=2, hidden_dim=64):
        super(SABES, self).__init__()
        # Encoder: RNN cell structure (as per paper 3.3 and 4.2: 64 hidden units)
        self.encoder = nn.RNN(input_dim, 64, batch_first=True, nonlinearity='tanh')
        
        # Decoder
        self.decoder_cell = nn.RNNCell(input_dim, 64, nonlinearity='tanh')
        self.output_layer = nn.Linear(64, input_dim)
        self.hidden_dim = hidden_dim
        self.fc = nn.Linear(64, hidden_dim)

    def forward(self, x):
        # x: (batch_size, seq_len, 2)
        # 1. Encoding
        out_enc, h_n = self.encoder(x)
        embedding = h_n[-1] # Final hidden state e_va
        
        # 2. Decoding (Reconstruction)
        batch_size, seq_len, _ = x.shape
        decoded_outputs = []
        
        # Initial decoder hidden state is the embedding
        h_t = embedding
        # Initial input for decoder (typically zero or last input)
        x_hat_t = torch.zeros_like(x[:, 0, :])
        
        for t in range(seq_len):
            h_t = self.decoder_cell(x_hat_t, h_t)
            x_hat_t = self.output_layer(h_t)
            decoded_outputs.append(x_hat_t.unsqueeze(1))
            
        reconstructed_x = torch.cat(decoded_outputs, dim=1)
        
        # Embedding projection
        z_sabes = self.fc(embedding)
        return z_sabes, reconstructed_x

class CoAttention(nn.Module):
    """
    Co-Attention Mechanism
    Analyzes the correlation and inter-dependencies between PTE and SABES embeddings.
    """
    def __init__(self, d):
        super(CoAttention, self).__init__()
        self.d = d
        
    def forward(self, f1, f2):
        # f1: PTE embedding (batch_size, d)
        # f2: SABES embedding (batch_size, d)
        
        # As per Formula 15 & 16
        # CA1 = softmax(F1 * F2^T / sqrt(d)) * F2
        # F1.unsqueeze(1) -> (B, 1, d)
        # F2.unsqueeze(2) -> (B, d, 1)
        
        # Reshape for dot product
        q1 = f1.unsqueeze(1)
        k1 = f2.unsqueeze(1)
        v1 = f2.unsqueeze(1)
        
        # Numerical stability: scale and clamp
        scores1 = torch.bmm(q1, k1.transpose(1, 2)) / (self.d ** 0.5)
        scores1 = torch.clamp(scores1, min=-10.0, max=10.0) # Prevent overflow/underflow
        attn1 = F.softmax(scores1, dim=-1)
        ca1 = torch.bmm(attn1, v1).squeeze(1)
        
        q2 = f2.unsqueeze(1)
        k2 = f1.unsqueeze(1)
        v2 = f1.unsqueeze(1)
        
        scores2 = torch.bmm(q2, k2.transpose(1, 2)) / (self.d ** 0.5)
        scores2 = torch.clamp(scores2, min=-10.0, max=10.0)
        attn2 = F.softmax(scores2, dim=-1)
        ca2 = torch.bmm(attn2, v2).squeeze(1)
        
        return ca1, ca2

class TEMPER(nn.Module):
    """
    Final TEMPER Framework
    Combines STS, PTE, SABES, and Co-Attention.
    """
    def __init__(self, pte_dim=8, sabes_dim=2, hidden_dim=64):
        super(TEMPER, self).__init__()
        self.pte = PTE(input_dim=pte_dim, hidden_dim=hidden_dim)
        self.sabes = SABES(input_dim=sabes_dim, hidden_dim=hidden_dim)
        self.co_attention = CoAttention(d=hidden_dim)
        
        # Classification layer (F1 + F2 + CA1 + CA2)
        self.classifier = nn.Sequential(
            nn.Linear(hidden_dim * 4, 128),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(128, 1),
            nn.Sigmoid()
        )
        
    def forward(self, x_pte, x_sabes):
        # x_pte: (batch_size, seq_len, 8)
        # x_sabes: (batch_size, seq_len, 2)
        
        f1 = self.pte(x_pte)
        f2, x_recon = self.sabes(x_sabes)
        
        ca1, ca2 = self.co_attention(f1, f2)
        
        combined = torch.cat([f1, f2, ca1, ca2], dim=1)
        risk_score = self.classifier(combined)
        
        return risk_score, {
            'pte_embedding': f1,
            'sabes_embedding': f2,
            'ca1': ca1,
            'ca2': ca2,
            'combined_embedding': combined,
            'reconstruction': x_recon
        }

def get_model():
    # As per paper: hidden_dim (d) = 64
    model = TEMPER(pte_dim=8, sabes_dim=2, hidden_dim=64)
    model.eval()
    return model

