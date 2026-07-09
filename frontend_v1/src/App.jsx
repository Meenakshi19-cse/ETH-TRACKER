import { useState, useEffect, useMemo } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import './App.css'

function App() {
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState('overview')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState(null)
  const [forensicData, setForensicData] = useState(null)
  const [osintData, setOsintData] = useState(null)

  // Live Monitoring & Network Graph States
  const [riskyAddresses, setRiskyAddresses] = useState([])
  const [selectedGraphAddress, setSelectedGraphAddress] = useState(null)
  const [graphData, setGraphData] = useState({ nodes: [], links: [] })
  const [liveAlerts, setLiveAlerts] = useState([])
  const [selectedGraphElement, setSelectedGraphElement] = useState(null)
  const [timeFilter, setTimeFilter] = useState('ALL')
  const [minDegree, setMinDegree] = useState(0)
  const [riskyPage, setRiskyPage] = useState(1)
  const [totalRiskyPages, setTotalRiskyPages] = useState(1)

  const activeGraphData = useMemo(() => {
    if (!graphData || !graphData.nodes) return { nodes: [], links: [] }

    const now = Math.floor(Date.now() / 1000)
    let timeLimit = 0
    if (timeFilter === '24H') timeLimit = now - 24 * 3600
    if (timeFilter === '7D') timeLimit = now - 7 * 24 * 3600

    const rootAddr = String(selectedGraphAddress || '').toLowerCase()

    // Filter links by time
    const filteredLinks = graphData.links.filter(link => {
      if (timeLimit === 0 || !link.timestamp) return true
      return Number(link.timestamp) >= timeLimit
    })

    // Compute node degrees based on filtered links
    const nodeDegrees = new Map()
    filteredLinks.forEach(link => {
      // Handle both raw strings and d3-processed objects
      const src = (typeof link.source === 'object' ? link.source.id : link.source).toLowerCase()
      const tgt = (typeof link.target === 'object' ? link.target.id : link.target).toLowerCase()

      nodeDegrees.set(src, (nodeDegrees.get(src) || 0) + 1)
      nodeDegrees.set(tgt, (nodeDegrees.get(tgt) || 0) + 1)
    })

    // Filter nodes by degree threshold
    const filteredNodes = graphData.nodes.filter(node => {
      const nodeId = String(node.id || '').toLowerCase()
      const isRoot = nodeId === rootAddr
      if (isRoot) return true

      const deg = nodeDegrees.get(nodeId) || 0
      // If a time filter is active, we hide nodes with no connections in that range
      // This prevents the original "spreading" issue where nodes float away with no links.
      const threshold = (timeLimit > 0) ? Math.max(minDegree, 1) : minDegree
      return deg >= threshold
    })

    // Keep only links that point to the remaining valid nodes
    const finalNodeIds = new Set(filteredNodes.map(n => String(n.id || '').toLowerCase()))
    const finalLinks = filteredLinks.filter(link => {
      const src = (typeof link.source === 'object' ? link.source.id : link.source).toLowerCase()
      const tgt = (typeof link.target === 'object' ? link.target.id : link.target).toLowerCase()
      return finalNodeIds.has(src) && finalNodeIds.has(tgt)
    })

    return { nodes: filteredNodes, links: finalLinks }
  }, [graphData, timeFilter, minDegree, selectedGraphAddress])



  useEffect(() => {
    fetch(`/api/risky-addresses?page=${riskyPage}&limit=10`)
      .then(res => res.json())
      .then(d => {
        if (d.addresses) {
          setRiskyAddresses(d.addresses)
          setTotalRiskyPages(d.totalPages || 1)
        }
      })
      .catch(console.error)
  }, [riskyPage])

  // Setup SSE for live alerts
  useEffect(() => {
    const eventSource = new EventSource('/api/stream')
    eventSource.onmessage = (event) => {
      try {
        const d = JSON.parse(event.data)
        if (d.type === 'risky_tx') {
          setLiveAlerts(prev => [d, ...prev].slice(0, 10))
        }
      } catch (err) {
        console.error('Error parsing SSE:', err)
      }
    }

    return () => eventSource.close()
  }, [])

  const onSelectRiskyAddress = async (addr) => {
    setSelectedGraphAddress(addr)
    setSelectedGraphElement(null)
    try {
      const res = await fetch(`/api/graph/${addr}`)
      const d = await res.json()
      if (d.nodes && d.links) {
        setGraphData(d)
      }
    } catch (err) {
      console.error('Error fetching graph:', err)
    }
  }

  const normalizeInput = (raw) => {
    const text = String(raw || '').trim()
    if (!text) return ''

    const txMatch = text.match(/0x[a-fA-F0-9]{64}/)
    if (txMatch) return txMatch[0]

    const addrMatch = text.match(/0x[a-fA-F0-9]{40}/)
    if (addrMatch) return addrMatch[0]

    return text
  }

  const onAnalyze = async () => {
    setError('')
    setData(null)
    const trimmed = normalizeInput(query)
    const isTx = /^0x([A-Fa-f0-9]{64})$/.test(trimmed)
    const isAddr = /^0x([A-Fa-f0-9]{40})$/.test(trimmed)
    if (!isTx && !isAddr) {
      setError('Enter a valid Ethereum transaction hash or wallet address.')
      return
    }

    setLoading(true)
    try {
      const resp = await fetch(`/api/analyze/${encodeURIComponent(trimmed)}`)
      const json = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        setError(json?.error || `Request failed (${resp.status})`)
        return
      }
      setData(json)

      // Also fetch forensic data
      const forResp = await fetch(`/api/forensics/${encodeURIComponent(trimmed)}`)
      const forJson = await forResp.json().catch(() => null)
      setForensicData(forJson)

      // Fetch OSINT enrichment
      if (isAddr) {
        const osintResp = await fetch(`/api/osint/enrich/${encodeURIComponent(trimmed)}`)
        const osintJson = await osintResp.json().catch(() => null)
        setOsintData(osintJson)
      } else if (isTx && json.address?.address) {
        const osintResp = await fetch(`/api/osint/enrich/${encodeURIComponent(json.address.address)}`)
        const osintJson = await osintResp.json().catch(() => null)
        setOsintData(osintJson)
      }

      setTab('overview')
      setQuery(trimmed)
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }

  const renderValueEth = (wei) => {
    if (!wei) return '0'
    const n = BigInt(wei)
    const whole = n / 1000000000000000000n
    const frac = n % 1000000000000000000n
    const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '')
    return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString()
  }

  const formatDate = (val) => {
    if (!val) return 'N/A';
    // Handle both Unix timestamp (seconds) and ISO strings
    const date = typeof val === 'number' ? new Date(val * 1000) : new Date(val);
    if (isNaN(date.getTime())) return 'N/A';
    return date.toLocaleString('en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  const shorten = (v) => {
    if (!v || typeof v !== 'string') return ''
    if (v.length <= 14) return v
    return `${v.slice(0, 6)}...${v.slice(-4)}`
  }

  const downloadPDF = () => {
    if (!data || !forensicData) return;
    const doc = new jsPDF();
    const timestamp = new Date().toLocaleString();
    let currentY = 50;

    const checkPage = (heightNeeded) => {
      if (currentY + heightNeeded > 280) {
        doc.addPage();
        currentY = 20;
        return true;
      }
      return false;
    };

    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 210, 45, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.text('FORENSIC INTELLIGENCE MANIFEST', 20, 22);
    doc.setFontSize(9);
    doc.setFont('courier', 'normal');
    doc.text(`REPORT_ID: ${Math.random().toString(36).substr(2, 9).toUpperCase()}`, 20, 32);
    doc.text(`GEN_TIME: ${timestamp}`, 20, 37);
    doc.text(`SUBJECT_HASH: ${forensicData.step1.hash || 'DIRECT_ADDRESS_SCAN'}`, 20, 42);

    currentY = 60;
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('I. SUBJECT IDENTIFICATION & RISK PROFILE', 20, currentY);
    currentY += 8;

    autoTable(doc, {
      startY: currentY,
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 3 },
      columnStyles: { 0: { fontStyle: 'bold', fillColor: [241, 245, 249], width: 60 } },
      body: [
        ['Target Wallet Address', data.address?.address || 'N/A'],
        ['On-Chain Attribution', data.address?.isContract ? 'Verified Smart Contract' : 'External Owned Account (EOA)'],
        ['Primary Risk Rating', (osintData?.risk_score > 50 ? 'RISKY USER' : (forensicData.step3.label || data.risk?.level || 'LOW').toUpperCase())],
        ['AI Behavioral Classifier', forensicData.step4?.likelyType || 'Normal User'],
        ['TEMPER Confidence Score', `${forensicData.step4?.confidenceScore || 0}%`]
      ]
    });
    currentY = doc.lastAutoTable.finalY + 15;

    checkPage(60);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('II. QUANTITATIVE FINANCIAL EVIDENCE', 20, currentY);
    currentY += 8;

    autoTable(doc, {
      startY: currentY,
      head: [['Metrics Category', 'Measured Value']],
      body: [
        ['Current Liquid Balance', `${renderValueEth(data.summary?.balanceWei)} ETH`],
        ['Historical Inflow (Sample)', `${renderValueEth(data.summary?.totalReceivedWei)} ETH`],
        ['Historical Outflow (Sample)', `${renderValueEth(data.summary?.totalSentWei)} ETH`],
        ['Unique Network Counterparty Count', data.summary?.connectedCount || 0],
        ['Total Sampled Transactions', data.summary?.txSampleCount || 0],
      ],
      headStyles: { fillColor: [51, 65, 85] },
      theme: 'striped'
    });
    currentY = doc.lastAutoTable.finalY + 15;

    checkPage(80);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('III. FUND FLOW TRACE MANIFEST (HOPS)', 20, currentY);
    currentY += 8;

    const hopRows = (data.trace?.hops || []).map(h => [
      h.depth,
      shorten(h.txHash),
      shorten(h.to),
      h.entityHit ? h.entityHit.name : 'Unknown EOA',
      `${renderValueEth(h.valueWei)} ETH`
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [['Hop', 'TX Hash', 'Destination', 'Entity Name', 'Value (ETH)']],
      body: hopRows.length > 0 ? hopRows : [['-', 'No outgoing hops detected', '-', '-', '-']],
      styles: { fontSize: 8 },
      headStyles: { fillColor: [15, 23, 42] }
    });
    currentY = doc.lastAutoTable.finalY + 15;

    checkPage(80);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('IV. NETWORK CLUSTERING (TOP COUNTERPARTIES)', 20, currentY);
    currentY += 8;

    const cpRows = (data.summary?.clustering?.topCounterparties || []).map(cp => [
      cp.address,
      cp.count
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [['Counterparty Address', 'Interaction Count']],
      body: cpRows.length > 0 ? cpRows : [['No significant counterparties identified in sample', '0']],
      styles: { fontSize: 8 },
      headStyles: { fillColor: [30, 41, 59] }
    });
    currentY = doc.lastAutoTable.finalY + 15;

    checkPage(60);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('V. ANONYMITY SET & MIXER CORRELATION', 20, currentY);
    currentY += 8;

    const tornCorrs = (data.deAnonymization?.tornado?.correlations || []).map(c => [
      shorten(c.depositTxHash),
      shorten(c.withdrawTxHash),
      `${c.score}%`,
      `${c.timeDeltaSeconds}s`
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [['Deposit TX', 'Withdraw TX', 'Heuristic Score', 'Time Delta']],
      body: tornCorrs.length > 0 ? tornCorrs : [['None', 'No mixer correlations found with provided data', '-', '-']],
      styles: { fontSize: 8 },
      headStyles: { fillColor: [153, 27, 27] }
    });
    currentY = doc.lastAutoTable.finalY + 15;

    checkPage(80);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('VI. NETWORK TOPOLOGY (TOPOLOGICAL EDGE DATA)', 20, currentY);
    currentY += 8;

    const edgeRows = (data.graph?.edges || []).slice(0, 15).map(e => [
      shorten(e.from),
      shorten(e.to),
      e.kind.toUpperCase(),
      e.meta?.value || e.meta?.valueWei || 'N/A'
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [['Source', 'Destination', 'Kind', 'Weight/Value']],
      body: edgeRows.length > 0 ? edgeRows : [['No graph edges available', '-', '-', '-']],
      styles: { fontSize: 8 },
      headStyles: { fillColor: [71, 85, 105] }
    });
    currentY = doc.lastAutoTable.finalY + 15;

    checkPage(60);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('VII. OSINT INTELLIGENCE OVERLAY', 20, currentY);
    currentY += 8;

    if (osintData && osintData.offchain_mentions?.length > 0) {
      autoTable(doc, {
        startY: currentY,
        head: [['Source Platform', 'Context / Evidence Context']],
        body: osintData.offchain_mentions.map(m => [m.platform.toUpperCase(), m.context]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [30, 58, 138] }
      });
      currentY = doc.lastAutoTable.finalY + 15;
    } else {
      doc.setFontSize(10);
      doc.setFont('helvetica', 'italic');
      doc.text('Scan completed. No public darknet or forum hits identified for this address.', 20, currentY + 5);
      currentY += 20;
    }

    checkPage(50);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('VIII. TEMPER AI ATTRIBUTION ANALYSIS', 20, currentY);
    currentY += 8;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    const reasonText = doc.splitTextToSize(`Behavioral Logic: ${forensicData.step2.temper_prediction?.reason || 'Standard behavior pattern detected.'}`, 170);
    doc.text(reasonText, 20, currentY);
    currentY += (reasonText.length * 5) + 15;

    checkPage(40);
    doc.setFillColor(248, 250, 252);
    doc.rect(15, currentY, 180, 25, 'F');
    doc.setDrawColor(203, 213, 225);
    doc.rect(15, currentY, 180, 25, 'S');

    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('FINAL INVESTIGATOR SUMMARY', 20, currentY + 10);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`The entity ${shorten(data.address?.address)} is classified as ${osintData?.risk_score > 50 ? 'RISKY USER' : (forensicData.step3.label || 'LOW')}. Classification is based on automated heuristics and OSINT signals.`, 20, currentY + 18);

    // Footer
    const totalPages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setTextColor(148, 163, 184);
      doc.setFontSize(7);
      doc.text(`CONFIDENTIAL INTEL - PAGE ${i} OF ${totalPages} | SYSTEM_V2_BFEAS | AUTH_ONLY`, 105, 285, { align: 'center' });
    }

    const fileName = `Forensic_Manifest_${data.address?.address.slice(0, 10)}.pdf`;
    doc.save(fileName);
  };


  const risk = data?.risk
  const summary = data?.summary
  const addr = data?.address
  const mixerExposure = data?.exposure?.mixer
  const exchangeExposure = data?.exposure?.exchange
  const exitPoints = data?.kycExitPoints || []
  const hops = data?.trace?.hops || []
  const dean = data?.deAnonymization

  const riskVariant = (risk?.level || 'LOW').toLowerCase()
  const riskLabel = risk?.level || 'LOW'

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand">
          <h1 className="brand-title">ETH TRACKER</h1>
          <p className="brand-subtitle">Forensic Investigation Dashboard</p>
        </div>

        <div className="search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Paste tx hash or wallet address"
            className="search-input"
          />
          <button className="search-btn" onClick={onAnalyze} disabled={loading}>
            {loading ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
      </div>

      <div className="tabs">
        <button
          className={`tab ${tab === 'monitoring' ? 'tab-active' : ''}`}
          onClick={() => setTab('monitoring')}
        >
          Live Monitoring & Network
        </button>
        <button
          className={`tab ${tab === 'overview' ? 'tab-active' : ''}`}
          onClick={() => setTab('overview')}
        >
          Overview
        </button>
        <button
          className={`tab ${tab === 'forensics' ? 'tab-active' : ''}`}
          onClick={() => setTab('forensics')}
          disabled={!forensicData}
        >
          Forensic Report
        </button>
        <button
          className={`tab ${tab === 'osint' ? 'tab-active' : ''}`}
          onClick={() => setTab('osint')}
          disabled={!osintData}
        >
          OSINT Enrichment
        </button>
        <button
          className={`tab ${tab === 'trace' ? 'tab-active' : ''}`}
          onClick={() => setTab('trace')}
          disabled={!data}
        >
          Hop Trace
        </button>
        <button
          className={`tab ${tab === 'details' ? 'tab-active' : ''}`}
          onClick={() => setTab('details')}
          disabled={!data}
        >
          Raw Data
        </button>
      </div>

      {error ? <div className="alert-error">{error}</div> : null}

      {!data && !loading && tab !== 'monitoring' ? (
        <div className="panel" style={{ textAlign: 'center', padding: '5rem' }}>
          <h2 className="brand-title" style={{ fontSize: '2rem' }}>START INVESTIGATION</h2>
          <p className="muted">Enter an Ethereum address or transaction hash to begin.</p>
        </div>
      ) : null}

      {loading && tab !== 'monitoring' ? (
        <div className="panel loading-container">
          <div className="scanner-line"></div>
          <div className="brand-title" style={{ fontSize: '1.5rem', animation: 'pulse 2s infinite' }}>ANALYZING BLOCKCHAIN...</div>
          <p className="muted">Tracing fund flows and performing temporal behavioral analysis with TEMPER AI.</p>
        </div>
      ) : null}

      {tab === 'monitoring' && (
        <div className="grid grid-2">
          <div className="panel" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
            <div className="panel-title">Live Alerts</div>
            {liveAlerts.length === 0 ? <p className="muted">No risky transactions detected recently.</p> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '2rem' }}>
                {liveAlerts.map((alert, i) => (
                  <div key={i} className="alert-error" style={{ fontSize: '0.8rem', padding: '0.7rem', background: alert.isWatchlistHit ? '#450a0a' : '#300', borderLeft: alert.isWatchlistHit ? '4px solid #ef4444' : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>{alert.reason}</strong>
                      {alert.isWatchlistHit && <span style={{ background: '#7f1d1d', padding: '1px 5px', fontSize: '10px', borderRadius: '4px' }}>WATCHLIST</span>}
                    </div>
                    <div className="mono" style={{ fontSize: '0.75rem', margin: '3px 0', opacity: 0.8, color: '#6ee7b7' }}>TX: {alert.txHash}</div>
                    <div className="mono" style={{ fontSize: '0.7rem', margin: '2px 0', color: '#94a3b8' }}>
                      <span style={{ color: '#aaa' }}>FROM:</span> {alert.fromAddress}
                    </div>
                    <div className="mono" style={{ fontSize: '0.7rem', margin: '2px 0', color: '#94a3b8' }}>
                      <span style={{ color: '#aaa' }}>TO:</span> {alert.toAddress}
                    </div>
                    <div style={{ fontWeight: 'bold', color: '#fca5a5' }}>Val: {renderValueEth(alert.valueWei)} ETH</div>

                    {alert.historyCount && (
                      <div style={{ marginTop: '5px', paddingTop: '5px', borderTop: '1px solid rgba(255,255,255,0.1)', fontSize: '0.75rem', color: '#fca5a5' }}>
                        📜 Lifetime activity: <br />
                        <strong>{alert.historyCount} Transactions</strong> • <strong>{renderValueEth(alert.historyVolumeWei)} ETH</strong>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="panel-title">Risky Addresses from DB</div>
            {riskyAddresses.length === 0 ? <p className="muted">No addresses found.</p> : (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                <ul style={{ listStyle: 'none', padding: 0, flex: 1, overflowY: 'auto', minHeight: '300px' }}>
                  {riskyAddresses.map((a) => (
                    <li key={a} style={{ marginBottom: '0.5rem' }}>
                      <button
                        className="tab"
                        style={{ width: '100%', textAlign: 'left', padding: '0.5rem', background: selectedGraphAddress === a ? 'var(--accent-primary)' : 'transparent' }}
                        onClick={() => onSelectRiskyAddress(a)}
                      >
                        {shorten(a)}
                      </button>
                    </li>
                  ))}
                </ul>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #333' }}>
                  <button
                    disabled={riskyPage <= 1}
                    onClick={() => setRiskyPage(p => Math.max(1, p - 1))}
                    style={{ background: '#333', color: '#fff', border: 'none', padding: '0.4rem 0.8rem', borderRadius: '4px', cursor: riskyPage <= 1 ? 'not-allowed' : 'pointer' }}
                  >
                    Previous
                  </button>
                  <span style={{ fontSize: '0.8rem', color: '#aaa' }}>Page {riskyPage} of {totalRiskyPages}</span>
                  <button
                    disabled={riskyPage >= totalRiskyPages}
                    onClick={() => setRiskyPage(p => Math.min(totalRiskyPages, p + 1))}
                    style={{ background: '#333', color: '#fff', border: 'none', padding: '0.4rem 0.8rem', borderRadius: '4px', cursor: riskyPage >= totalRiskyPages ? 'not-allowed' : 'pointer' }}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="panel" style={{ height: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
              <span>Network Graph {selectedGraphAddress ? `- ${shorten(selectedGraphAddress)}` : ''}</span>
              {selectedGraphAddress && (
                <div style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: '#aaa' }}>Time:</span>
                    <select value={timeFilter} onChange={e => setTimeFilter(e.target.value)} style={{ background: '#222', color: '#fff', border: '1px solid #444', padding: '0.3rem', borderRadius: '4px', outline: 'none' }}>
                      <option value="ALL">All Time</option>
                      <option value="24H">Last 24 Hours</option>
                      <option value="7D">Last 7 Days</option>
                    </select>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: '#aaa' }}>Min Connections:</span>
                    <span style={{ width: '12px', textAlign: 'center' }}>{minDegree}</span>
                    <input type="range" min="0" max="10" value={minDegree} onChange={e => setMinDegree(parseInt(e.target.value))} style={{ width: '80px', accentColor: '#ff3366' }} />
                  </label>
                </div>
              )}
            </div>
            <div style={{ flex: 1, background: '#111', borderRadius: '8px', overflow: 'hidden', display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative' }}>
              {selectedGraphAddress ? (
                <>
                  <ForceGraph2D
                    graphData={activeGraphData}
                    nodeLabel="label"
                    nodeColor={node => node.id === selectedGraphAddress ? '#ff3366' : '#228be6'}
                    nodeRelSize={4}
                    linkColor={() => 'rgba(255,255,255,0.1)'}
                    linkDirectionalArrowLength={2}
                    linkDirectionalArrowRelPos={1}
                    onNodeClick={(node) => setSelectedGraphElement({ type: 'node', ...node })}
                    onLinkClick={(link) => setSelectedGraphElement({ type: 'link', ...link })}
                    cooldownTicks={100}
                    d3AlphaDecay={0.01}
                    d3VelocityDecay={0.08}
                  />
                  {selectedGraphElement && (
                    <div style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,0.85)', padding: '1.2rem', borderRadius: '8px', zIndex: 10, border: '1px solid #333', maxWidth: '300px', wordWrap: 'break-word', color: '#fff', fontSize: '0.9rem', boxShadow: '0 4px 6px rgba(0,0,0,0.3)', pointerEvents: 'auto' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
                        <h3 style={{ margin: 0, fontSize: '1rem', color: '#ff3366' }}>{selectedGraphElement.type === 'node' ? 'Address Details' : 'Transaction Info'}</h3>
                        <button onClick={() => setSelectedGraphElement(null)} style={{ background: 'none', border: 'none', color: '#ccc', cursor: 'pointer', fontSize: '1.2rem', padding: '0 0.5rem', lineHeight: 1 }}>&times;</button>
                      </div>
                      {selectedGraphElement.type === 'node' ? (
                        <>
                          <div style={{ color: '#aaa', marginBottom: '4px', fontSize: '0.8rem', textTransform: 'uppercase' }}>Address</div>
                          <div className="mono" style={{ marginBottom: '0.5rem', color: '#6ee7b7' }}>{selectedGraphElement.id}</div>
                        </>
                      ) : (
                        <>
                          <div style={{ color: '#aaa', marginBottom: '4px', fontSize: '0.8rem', textTransform: 'uppercase' }}>Transaction Hash</div>
                          <div className="mono" style={{ marginBottom: '1rem', color: '#6ee7b7' }}>{selectedGraphElement.txHash || 'N/A'}</div>

                          <div style={{ color: '#aaa', marginBottom: '4px', fontSize: '0.8rem', textTransform: 'uppercase' }}>From Address</div>
                          <div className="mono" style={{ marginBottom: '1rem', color: '#6ee7b7' }}>{selectedGraphElement.source?.id || selectedGraphElement.source}</div>

                          <div style={{ color: '#aaa', marginBottom: '4px', fontSize: '0.8rem', textTransform: 'uppercase' }}>To Address</div>
                          <div className="mono" style={{ marginBottom: '1rem', color: '#6ee7b7' }}>{selectedGraphElement.target?.id || selectedGraphElement.target}</div>

                          <div style={{ color: '#aaa', marginBottom: '4px', fontSize: '0.8rem', textTransform: 'uppercase' }}>Value (Wei)</div>
                          <div className="mono" style={{ color: '#fcd34d' }}>{selectedGraphElement.valueWei?.toString() || '0'}</div>
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="muted">Select a risky address to view its connections.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {data && tab === 'overview' && !loading ? (
        <>
          <div className="grid grid-2">
            <div className="panel">
              <div className="panel-title">{addr?.display || shorten(addr?.address)}</div>
              <div className={`badge badge-${riskVariant}`}>{riskLabel} RISK</div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                {osintData?.seen_on?.map(p => (
                  <span key={p} className="badge" style={{ background: '#334155', color: '#cbd5e1', fontSize: '0.7rem' }}>
                    🌐 {p.toUpperCase()}
                  </span>
                ))}
              </div>

              <div className="kpi-grid">
                <div className="kpi">
                  <div className="kpi-label">Current Balance</div>
                  <div className="kpi-value">{renderValueEth(summary?.balanceWei)} ETH</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">Unique Counterparties</div>
                  <div className="kpi-value">{summary?.connectedCount ?? 0}</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">Total Received</div>
                  <div className="kpi-value">{renderValueEth(summary?.totalReceivedWei)} ETH</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">Total Sent</div>
                  <div className="kpi-value">{renderValueEth(summary?.totalSentWei)} ETH</div>
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">Forensic Reasoning</div>
              <p style={{ lineHeight: '1.6', fontSize: '1.1rem', color: 'var(--text-primary)', marginBottom: '2rem', fontStyle: 'italic', borderLeft: '4px solid var(--accent-primary)', paddingLeft: '1.5rem' }}>
                {risk?.reasoning || 'Analyzing behavioral patterns...'}
              </p>

              <div className="panel-title">Exposure Analysis</div>

              <div className={`exposure ${mixerExposure?.hit || osintData?.darknet_hit ? 'exposure-bad' : 'exposure-good'}`}>
                <div className="exposure-title">
                  {osintData?.darknet_hit ? '🚨 DARKNET MARKET HIT' : mixerExposure?.hit ? 'MIXER EXPOSURE' : 'CLEAN (NO MIXERS)'}
                </div>
                <div className="exposure-subtitle">
                  {osintData?.darknet_hit
                    ? `Intelligence identifies this as a Darknet Market node (Hydra/Market).`
                    : mixerExposure?.hit
                      ? `Interaction with ${mixerExposure?.entity?.name || 'known mixer'} detected.`
                      : 'No interactions with known mixers/tumblers detected.'}
                </div>
              </div>

              <div className={`exposure ${exchangeExposure?.hit || osintData?.nested_exchange_hit ? 'exposure-warn' : 'exposure-good'}`}>
                <div className="exposure-title">
                  {osintData?.nested_exchange_hit ? '⚠️ NESTED EXCHANGE HIT' : exchangeExposure?.hit ? 'EXCHANGE HIT' : 'NO EXCHANGE EXIT'}
                </div>
                <div className="exposure-subtitle">
                  {osintData?.nested_exchange_hit
                    ? 'Interaction with an unregulated, high-risk nested exchange detected.'
                    : exchangeExposure?.hit
                      ? `Funds path leads to ${exchangeExposure?.entity?.name || 'a known exchange'}.`
                      : 'No known exchange exit points in traced hops.'}
                </div>
              </div>

              <div style={{ marginTop: '2rem' }}>
                <p className="kpi-label">Risk Indicators</p>
                {risk?.indicators?.length ? (
                  <ul className="muted" style={{ paddingLeft: '1.2rem', marginTop: '0.5rem' }}>
                    {risk.indicators.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No immediate risk signals found.</p>
                )}
              </div>

              {osintData?.offchain_mentions?.length > 0 && (
                <div style={{ marginTop: '2rem', padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '12px' }}>
                  <p className="kpi-label">🌐 OSINT Intel & Proof</p>
                  <div style={{ marginTop: '0.5rem' }}>
                    {osintData.offchain_mentions.map((m, i) => (
                      <div key={i} style={{ fontSize: '0.8rem', color: '#cbd5e1', marginBottom: '0.5rem', borderLeft: '2px solid var(--accent-primary)', paddingLeft: '0.5rem' }}>
                        <strong>{m.platform.toUpperCase()}:</strong> {m.context}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}

      {forensicData && tab === 'forensics' && !loading ? (
        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
            <h2 className="panel-title" style={{ margin: 0 }}>Step-by-Step Forensic Report</h2>
            <button className="search-btn" onClick={downloadPDF} style={{ padding: '0.6rem 1.2rem', fontSize: '0.85rem', background: 'var(--accent-primary)', color: '#000', border: 'none', borderRadius: '10px', cursor: 'pointer', fontWeight: '800', letterSpacing: '0.05em' }}>
              📤 Download Official PDF
            </button>
          </div>
          <div className="forensic-steps">
            <div className="forensic-step">
              <div className="step-num">1</div>
              <div className="step-title">Transaction Baseline</div>
              <div className="kpi-grid">
                <div className="kpi">
                  <div className="kpi-label">Origin</div>
                  <div className="kpi-value mono" style={{ fontSize: '0.9rem' }}>{forensicData.step1.from}</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">Value</div>
                  <div className="kpi-value">{forensicData.step1.value || '0'} ETH</div>
                </div>
              </div>
            </div>

            <div className="forensic-step">
              <div className="step-num">2</div>
              <div className="step-title">TEMPER AI Embeddings & Analysis</div>
              <div className="grid">
                <div className="panel" style={{ background: '#222' }}>
                  <div className="kpi-label">AI Explainability Reason</div>
                  <p style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>{forensicData.step2.temper_prediction?.reason || 'No data'}</p>
                </div>
                <div className="kpi-grid" style={{ marginTop: '1rem' }}>
                  <div className="kpi">
                    <div className="kpi-label">Sequence Model</div>
                    <div className="kpi-value" style={{ fontSize: '1rem' }}>{forensicData.step2.temper_prediction?.model_used || 'N/A'}</div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-label">Transactions Analyzed</div>
                    <div className="kpi-value" style={{ fontSize: '1.2rem' }}>{forensicData.step2.temper_prediction?.tx_count || 0}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="forensic-step">
              <div className="step-num">3</div>
              <div className="step-title">Node Classification</div>
              <div className="classification-card">
                <p className="kpi-label">Primary Behavior Alignment</p>
                <div className="value" style={{
                  color: forensicData.step3.label === 'HIGH' ? '#ff3366' : forensicData.step3.label === 'MEDIUM' ? '#ff4d00' : '#4ade80',
                  textShadow: forensicData.step3.label === 'LOW' ? '0 0 20px rgba(74, 222, 128, 0.2)' : '0 0 30px rgba(255, 51, 102, 0.3)'
                }}>
                  {forensicData.step3.label}
                </div>
              </div>
            </div>

            <div className="forensic-step">
              <div className="step-num">4</div>
              <div className="step-title">Final TEMPER AI Attribution Result</div>
              <div style={{ textAlign: 'center' }}>
                <p className="muted">The address is likely a:</p>
                <h2 className="brand-title" style={{ fontSize: '2.5rem' }}>{forensicData.step4.likelyType}</h2>
                <p className="kpi-label" style={{ marginTop: '1.5rem' }}>Risk Score: {forensicData.step4.confidenceScore}%</p>
                <div className="confidence-bar" style={{ background: 'rgba(255,255,255,0.05)', height: '14px' }}>
                  <div className="confidence-fill" style={{
                    width: `${Math.max(5, forensicData.step4.confidenceScore)}%`,
                    background: forensicData.step4.confidenceScore > 40 ? 'linear-gradient(90deg, #ff3366, #ff4d00)' : '#4ade80',
                    boxShadow: forensicData.step4.confidenceScore > 40 ? '0 0 20px rgba(255, 51, 102, 0.4)' : 'none'
                  }}></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {data && tab === 'trace' && !loading ? (
        <div className="panel">
          <div className="panel-title">Fund Flow Hop Trace</div>
          <p className="muted" style={{ marginBottom: '2rem' }}>
            Tracing fund flow from initiator — stops when an exchange is hit, no more outgoing transactions, or max depth is reached.
          </p>
          <div className="hop-chain">
            {/* INITIATOR NODE */}
            <div className="hop-node hop-node-initiator">
              <div className="hop-node-badge">INITIATOR</div>
              <div className="hop-node-address mono">{addr?.address || 'Unknown'}</div>
              <div className="hop-node-type-row">
                {hops[0]?.fromAddressType && (
                  <span className={`hop-type-badge ${hops[0].fromAddressType === 'CONTRACT' ? 'hop-type-contract' : 'hop-type-eoa'}`}>
                    {hops[0].fromAddressType === 'CONTRACT' ? '📜 Contract Account' : '👤 Personal EOA'}
                  </span>
                )}
                {addr?.isContract !== undefined && !hops[0]?.fromAddressType && (
                  <span className={`hop-type-badge ${addr.isContract ? 'hop-type-contract' : 'hop-type-eoa'}`}>
                    {addr.isContract ? '📜 Contract Account' : '👤 Personal EOA'}
                  </span>
                )}
              </div>
            </div>

            {hops.length === 0 ? (
              <div className="hop-arrow-wrap">
                <div className="hop-arrow-line" />
                <div className="hop-arrow-head">▼</div>
              </div>
            ) : null}

            {hops.map((h, i) => (
              <div key={i}>
                {/* ARROW */}
                <div className="hop-arrow-wrap">
                  <div className="hop-arrow-line" />
                  <div className="hop-arrow-label">{renderValueEth(h.valueWei)} ETH</div>
                  <div className="hop-arrow-head">▼</div>
                </div>


                <div className={`hop-node ${h.entityHit?.category === 'mixer' ? 'hop-node-mixer' : h.entityHit ? 'hop-node-entity' : 'hop-node-default'}`}>
                  <div className="hop-node-badge">HOP #{i + 1}</div>
                  <div className="hop-node-address mono">{h.to}</div>
                  <div className="hop-node-type-row">
                    {h.toAddressType && (
                      <span className={`hop-type-badge ${h.toAddressType === 'CONTRACT' ? 'hop-type-contract' : 'hop-type-eoa'}`}>
                        {h.toAddressType === 'CONTRACT' ? '📜 Contract Account' : '👤 Personal EOA'}
                      </span>
                    )}
                  </div>
                  {h.entityHit && (
                    <div className="hop-node-entity-tag">
                      {h.entityHit.category === 'mixer' ? '🚨' : '🏦'} {h.entityHit.name}
                    </div>
                  )}
                  {h.txHash && (
                    <div className="hop-node-tx">
                      TX: <span className="mono" style={{ fontSize: '0.7rem' }}>{shorten(h.txHash)}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* TERMINAL NODE */}
            <div className="hop-arrow-wrap">
              <div className="hop-arrow-line hop-arrow-line-terminal" />
              <div className="hop-arrow-head">▼</div>
            </div>
            <div className={`hop-node hop-node-terminal ${data?.trace?.stoppedReason === 'entity_hit' && data?.trace?.entityHit?.category === 'exchange'
              ? 'hop-node-exchange'
              : data?.trace?.stoppedReason === 'entity_hit' && data?.trace?.entityHit?.category === 'mixer'
                ? 'hop-node-mixer'
                : ''
              }`}>
              <div className="hop-node-badge">TRACE END</div>
              <div className="hop-terminal-reason">
                {data?.trace?.stoppedReason === 'entity_hit' && data?.trace?.entityHit
                  ? `${data.trace.entityHit.category === 'exchange' ? '🏦 EXCHANGE HIT' : data.trace.entityHit.category === 'mixer' ? '🚨 MIXER HIT' : '🎯 ENTITY HIT'} — ${data.trace.entityHit.name}`
                  : data?.trace?.stoppedReason === 'no_further_outgoing'
                    ? '🔚 No Further Outgoing Transactions'
                    : data?.trace?.stoppedReason === 'max_depth_reached'
                      ? `⛔ Max Depth Reached (${hops.length} hops)`
                      : data?.trace?.stoppedReason === 'cycle_detected'
                        ? '🔄 Cycle Detected'
                        : '⚪ Trace Completed'
                }
              </div>
              {data?.trace?.entityHit && (
                <div className="hop-node-address mono" style={{ marginTop: '0.5rem' }}>{data.trace.entityHit.address}</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {osintData && tab === 'osint' && !loading ? (
        <div className="panel">
          <div className="panel-title">OSINT Intelligence & De-anonymization</div>
          <div className="grid grid-2">
            <div className="panel" style={{ background: '#1e293b' }}>
              <div className="kpi-label">Entity Profile</div>
              <h2 style={{ color: '#38bdf8' }}>{osintData.entity_type.replace('_', ' ').toUpperCase()}</h2>
              <div className="kpi-grid" style={{ marginTop: '1rem' }}>
                <div className="kpi">
                  <div className="kpi-label">Risk Score</div>
                  <div className="kpi-value" style={{ color: osintData.risk_score > 50 ? '#fb7185' : '#34d399' }}>{osintData.risk_score}/100</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">Cross-Chain Presence</div>
                  <div className="kpi-value" style={{ fontSize: '1rem' }}>{osintData.chains.join(', ')}</div>
                </div>
              </div>
              {osintData.risk_score > 50 && (
                <div style={{ background: '#450a0a', color: '#fca5a5', padding: '0.7rem', borderRadius: '8px', marginTop: '1.5rem', textAlign: 'center', fontWeight: 'bold', border: '1px solid #7f1d1d' }}>
                  🚨 RISKY USER CLASSIFIED
                </div>
              )}
            </div>

            <div className="panel" style={{ background: '#0f172a' }}>
              <div className="panel-title" style={{ fontSize: '0.9rem' }}>Off-chain Mentions (Scraped)</div>
              {osintData.offchain_mentions.length === 0 ? (
                <p className="muted">No public forum mentions found for this address.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {osintData.offchain_mentions.map((m, i) => (
                    <div key={i} style={{ borderLeft: '3px solid #38bdf8', paddingLeft: '1rem' }}>
                      <div style={{ fontWeight: 'bold', color: '#38bdf8' }}>{m.platform.toUpperCase()} Hit</div>
                      <p style={{ fontSize: '0.85rem', margin: '0.2rem 0' }}>{m.context}</p>
                      <a href={m.url} target="_blank" rel="noreferrer" style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{m.url}</a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="panel" style={{ marginTop: '2rem', border: '1px dashed #334155' }}>
            <div className="kpi-label">Investigator Conclusion</div>
            <p className="muted" style={{ fontSize: '0.9rem' }}>
              This bridge between on-chain movement and off-chain discussion allows for high-confidence attribution.
              The presence of this address on <strong>{osintData.seen_on.join(' & ')}</strong> indicates a persistent profile.
              {osintData.risk_score > 50 && <span style={{ color: '#fb7185', fontWeight: 'bold' }}> This account is officially labeled as a Risky User based on identified threat vectors.</span>}
            </p>
          </div>
        </div>
      ) : null}

      {data && tab === 'details' && !loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          <div className="grid grid-2">
            <div className="panel">
              <div className="panel-title">Address Intelligence Metadata</div>
              <div className="kpi-grid">
                <div className="kpi">
                  <div className="kpi-label">Primary Hex String</div>
                  <div className="kpi-value mono" style={{ fontSize: '0.8rem' }}>{addr?.address}</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">Account Type</div>
                  <div className="kpi-value" style={{ fontSize: '1rem' }}>{addr?.isContract ? '📜 Smart Contract' : '👤 Individual EOA'}</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">Network Scope</div>
                  <div className="kpi-value" style={{ fontSize: '1rem' }}>Ethereum Mainnet</div>
                </div>
              </div>
            </div>

            {data.tx && (
              <div className="panel">
                <div className="panel-title">Seed Transaction Details</div>
                <div className="kpi-grid">
                  <div className="kpi">
                    <div className="kpi-label">Block Height</div>
                    <div className="kpi-value">{data.tx.blockNumber || 'Pending'}</div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-label">Transaction Status</div>
                    <div className="kpi-value" style={{ color: data.tx.status === 1 ? 'var(--success)' : 'var(--error)' }}>
                      {data.tx.status === 1 ? 'SUCCESS' : 'FAILED / REVERTED'}
                    </div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-label">Gas Consumed</div>
                    <div className="kpi-value">{data.tx.gasUsed || 'N/A'}</div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-label">Creation Time</div>
                    <div className="kpi-value" style={{ fontSize: '0.9rem' }}>{formatDate(data.tx.timestamp)}</div>
                  </div>
                </div>
              </div>
            )}
          </div>


        </div>
      ) : null}
    </div>
  )
}

export default App
