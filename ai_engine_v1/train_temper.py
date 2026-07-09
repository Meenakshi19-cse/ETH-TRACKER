import torch
import torch.optim as optim
import torch.nn as nn
from temper_model import get_model, STS
import numpy as np

def train_temper_epoch(model, optimizer, data_segments):
    """
    Trains the TEMPER model on temporally ordered segments produced by STS.
    This ensures temporal order and mitigates data leakage.
    """
    model.train()
    total_loss = 0
    
    # Loss functions as per paper
    # L1: MSE for PTE prediction (Future transaction values)
    # L2: MSE for SABES reconstruction
    mse_loss = nn.MSELoss()
    bce_loss = nn.BCELoss()
    
    for segment in data_segments:
        # 1. Prepare Features
        # Segment is a list of transactions (balanced by STS)
        # For simplicity, we assume features are already extracted
        # In a real scenario, we'd extract f1-f8 and delta_a, neighbor_ratio
        
        # Fake data for demonstration
        batch_size = 1 # We process segments one by one or in small batches
        seq_len = len(segment)
        if seq_len < 5: continue
        
        x_pte = torch.randn(batch_size, seq_len, 8, requires_grad=True)
        x_sabes = torch.randn(batch_size, seq_len, 2, requires_grad=True)
        y_true = torch.tensor([[1.0 if t.get('is_phishing') else 0.0 for t in segment]], dtype=torch.float32)
        # Final label for the user (segment summary)
        user_label = torch.tensor([[1.0 if any(t.get('is_phishing') for t in segment) else 0.0]], dtype=torch.float32)

        optimizer.zero_grad()
        
        # 2. Forward pass
        risk_score, outputs = model(x_pte, x_sabes)
        
        # 3. Calculate Losses
        # L2: SABES Reconstruction Loss
        recon_loss = mse_loss(outputs['reconstruction'], x_sabes)
        
        # Final Classification Loss
        class_loss = bce_loss(risk_score, user_label)
        
        # Total Loss (Aggregating modules)
        loss = class_loss + recon_loss
        
        loss.backward()
        optimizer.step()
        
        total_loss += loss.item()
        
    return total_loss / len(data_segments) if data_segments else 0

if __name__ == "__main__":
    # Example usage of STS + Training
    print("Initializing TEMPER Training with STS...")
    
    # 1. Simulate large dataset
    normal_tx = [{'timestamp': i, 'is_phishing': False, 'val': 0.1} for i in range(100)]
    phish_tx = [{'timestamp': i*5, 'is_phishing': True, 'val': 5.0} for i in range(10)]
    
    # 2. Apply STS (Mitigating Data Leakage)
    print(f"Applying STS on {len(normal_tx)} normal and {len(phish_tx)} phishing transactions...")
    segments = STS.sample(normal_tx, phish_tx)
    print(f"Generated {len(segments)} temporally ordered, balanced segments.")
    
    # 3. Initialize Model
    model = get_model()
    optimizer = optim.Adam(model.parameters(), lr=0.001)
    
    # 4. Train
    print("Starting training...")
    for epoch in range(5):
        loss = train_temper_epoch(model, optimizer, segments)
        print(f"Epoch {epoch+1}, Loss: {loss:.4f}")
    
    # 5. Save Model
    torch.save(model.state_dict(), "temper_trained.pth")
    print("Model saved to temper_trained.pth")
