import requests
import json

url = "http://127.0.0.1:8000/predict"
data = {
    "address": "0x123",
    "transactions": [
        {
            "f1_total_in_amt": 1.0,
            "f2_total_out_amt": 0.5,
            "f3_in_neighbor_count": 2.0,
            "f4_out_neighbor_count": 1.0,
            "f5_in_degree": 5.0,
            "f6_out_degree": 3.0,
            "f7_in_density": 2.5,
            "f8_out_density": 3.0
        }
    ] * 5
}

try:
    response = requests.post(url, json=data)
    print(f"Status Code: {response.status_code}")
    print(f"Response: {response.text}")
except Exception as e:
    print(f"Error: {e}")
