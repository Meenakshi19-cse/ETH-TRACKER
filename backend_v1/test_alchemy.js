import axios from 'axios';

async function test() {
    try {
        console.log('Testing /api/forensics endpoint...');
        // Using a known high-volume address or tx for testing
        const address = '0x88e9045352d01841ef73ec9f034c7fba73489679';
        const response = await axios.get(`http://localhost:5000/api/forensics/${address}`);
        console.log('Success!');
        console.log('Likely Type:', response.data.step4.likelyType);
        console.log('Confidence:', response.data.step4.confidenceScore);
        console.log('Trace Hops:', response.data.step2.trace.hops.length);
    } catch (error) {
        console.error('Test failed:', error);
    }
}

test();
