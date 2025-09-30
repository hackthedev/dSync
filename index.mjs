import express from "express"
import { randomUUID } from "crypto"

export default class dSync {
    constructor(prefix, app) {
        if (!prefix || typeof prefix !== "string" || prefix.length <= 0) {
            console.error("Prefix string is required for dSync!")
            process.exit(0)
        }
        if (!app) {
            console.error("Express app is required for dSync!")
            process.exit(0)
        }

        this.prefix = prefix
        this.handlers = new Map()
        this.peers = new Set()

        // memory
        this.seenEvents = new Map() // eventId { sources: Set, timer: NodeJS.Timeout }
        this.gossipDelay = this.getDynamicDelay() // some cool helpful shit

        app.use(express.json())
        app.post(`/${this.prefix}`, async (req, res) => {
            const { event, payload, eventId, source } = req.body
            const handlers = this.handlers.get(event) || []
            let responded = false
            const ip = req.ip || req.connection?.remoteAddress || "unknown"
            const interval = 60_000 // 1 minute

            // Gossip dedup logic
            if (!eventId) {
                res.json({ error: "Missing eventId" })
                return
            }

            if (!this.seenEvents.has(eventId)) {
                this.seenEvents.set(eventId, { sources: new Set(), timer: null })
            }

            const seen = this.seenEvents.get(eventId)
            seen.sources.add(source || "unknown")

            // clean up memory after 1 minute
            if (!seen.timer) {
                seen.timer = setTimeout(() => this.seenEvents.delete(eventId), 60_000)
            }

            for (const h of handlers) {
                const now = Date.now()
                let ipRateLimited = false
                let globalRateLimited = false

                if (h.options.ipRequestLimit) {
                    if (!h.ipHits[ip]) h.ipHits[ip] = []
                    h.ipHits[ip] = h.ipHits[ip].filter(ts => now - ts < interval)
                    if (h.ipHits[ip].length >= h.options.ipRequestLimit) {
                        ipRateLimited = true
                    } else {
                        h.ipHits[ip].push(now)
                    }
                }

                if (h.options.requestLimit) {
                    h.globalHits = h.globalHits.filter(ts => now - ts < interval)
                    if (h.globalHits.length >= h.options.requestLimit) {
                        globalRateLimited = true
                    } else {
                        h.globalHits.push(now)
                    }
                }

                if ((ipRateLimited || globalRateLimited) && !h.options.handleRateLimit) {
                    if (!responded) {
                        res.json({
                            error: "Rate limit exceeded",
                            ipRateLimited,
                            rateLimited: globalRateLimited,
                            rateLimitedIP: ip
                        })
                        responded = true
                    }
                    continue
                }

                const extendedPayload = {
                    ...payload,
                    ipRateLimited,
                    rateLimited: globalRateLimited,
                    rateLimitedIP: ip
                }

                h.handler(extendedPayload, (response) => {
                    if (!responded) {
                        res.json(response)
                        responded = true
                    }
                })
            }

            if (!responded) res.json(undefined)
        })
    }

    getDynamicDelay() {
        const peers = this.peers.size || 1
        const base = 200 // ms
        return Math.min(10_000, Math.floor(base * Math.log(peers + 1)))
    }


    on(event, optionsOrHandler, maybeHandler) {
        let handler, options
        if (typeof optionsOrHandler === "function") {
            handler = optionsOrHandler
            options = {}
        } else {
            options = optionsOrHandler || {}
            handler = maybeHandler
        }

        if (!this.handlers.has(event)) this.handlers.set(event, [])
        this.handlers.get(event).push({
            handler,
            options,
            ipHits: {},
            globalHits: []
        })
    }

    addPeer(url) {
        this.peers.add(url)
    }

    async emit(event, payload, { peers, callback } = {}) {
        const eventId = randomUUID()
        const targetPeers = peers || Array.from(this.peers)

        // merken: von uns selbst kam es auch
        this.seenEvents.set(eventId, { sources: new Set(["self"]), timer: setTimeout(() => {
                this.seenEvents.delete(eventId)
            }, 60_000) })

        // kleines Delay, um evtl. Duplikate zu sammeln
        await new Promise(r => setTimeout(r, this.gossipDelay))

        for (const url of targetPeers) {
            const seen = this.seenEvents.get(eventId)
            if (seen && seen.sources.has(url)) {
                continue // schon bekommen
            }

            try {
                const res = await fetch(`${url}/${this.prefix}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ event, payload, eventId, source: "self" })
                })
                if (typeof callback === "function") {
                    const data = await res.json().catch(() => undefined)
                    callback({ url, data })
                }
            } catch (err) {
                if (typeof callback === "function") {
                    callback({ url, error: err.message })
                }
            }
        }
    }
}
