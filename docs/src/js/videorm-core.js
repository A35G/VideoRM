'use strict';

var VideoRM = (userOptions = {}) => {
    const options = {
        showPremium: true,
        showPrivate: true,
        defaultVideoType: 'free',
        defaultCover: './src/img/poster/default.png',
        serverSide: false,          // non ancora utilizzata
        contentId: 'video-content',
        modalId: 'videoModal',
        closeId: 'closeVideo',
        playerId: 'videoPlayer',
        dataVideo: [],
        ...userOptions
    };

    // Parametri dell'anteprima al passaggio del mouse
    const PREVIEW = {
        maxDuration: 10,        // secondi massimi di anteprima per video corti
        shortThreshold: 15,     // sotto questa durata il video viene riprodotto dall'inizio
        segments: 4,            // numero di "spezzoni" per i video lunghi
        segmentDuration: 2.5    // durata di ogni spezzone (secondi)
    };

    const cardTpl = document.createElement('template');
    cardTpl.innerHTML = `
        <div class="vds">
            <div class="media-wrapper">
                <video class="uvd" muted playsinline preload="none"></video>

                <div class="top-badge">
                    <span class="badge-text"></span>
                </div>

                <div class="time-display">
                    <span class="duration">00:00</span>
                </div>
            </div>

            <div class="title-display">
                <span class="title-text"></span>
            </div>
        </div>
    `;

    const abort = new AbortController();    // per rimuovere i listener globali in destroy()
    const stoppers = new Set();             // funzioni stop() delle anteprime attive
    let container = null;
    let modal = null;
    let player = null;
    let observer = null;

    /* ------------------------------------------------------------------ *
     *  Utility
     * ------------------------------------------------------------------ */

    const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

    const pad = (n) => String(n).padStart(2, '0');

    const formatTime = (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0) return '--:--';

        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);

        return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    };

    const getType = (item) => (isBlank(item.typev) ? options.defaultVideoType : item.typev);

    const getCover = (item) => (isBlank(item.cover) ? options.defaultCover : item.cover);

    const getElement = (id) => {
        const el = document.getElementById(id);

        if (!el) throw new Error(`Need a HTML element with ID: ${id}`);

        return el;
    };

    /* ------------------------------------------------------------------ *
     *  Anteprima (hover)
     * ------------------------------------------------------------------ */

    const buildPreviewPositions = (duration) => {
        const { segments, segmentDuration } = PREVIEW;
        const start = duration * 0.10;
        const usable = duration * 0.80;

        return Array.from({ length: segments }, (_, i) => {
            let pos = start + usable * (i / (segments - 1));

            // un po' di casualità sugli spezzoni intermedi
            if (i !== 0 && i !== segments - 1) pos += (Math.random() * 2 - 1) * usable * 0.08;

            return Math.max(0, Math.min(pos, duration - segmentDuration));
        });
    };

    const createPreview = (video) => {
        let active = false;     // anteprima richiesta (mouse sopra la card)
        let dirty = false;      // il video è stato effettivamente mosso/riprodotto
        let timer = null;
        let onSeeked = null;
        let onMeta = null;

        const play = () => video.play().catch(() => { /* autoplay bloccato: ignorato */ });

        const clearPending = () => {
            clearTimeout(timer);
            timer = null;

            if (onSeeked) {
                video.removeEventListener('seeked', onSeeked);
                onSeeked = null;
            }

            if (onMeta) {
                video.removeEventListener('loadedmetadata', onMeta);
                onMeta = null;
            }
        };

        const stop = () => {
            const wasDirty = dirty;

            active = false;
            dirty = false;
            clearPending();

            // load() riporta il video allo stato iniziale, così torna visibile il poster
            if (wasDirty) {
                video.pause();
                video.load();
            }
        };

        const start = () => {
            if (!active) return;

            const duration = video.duration;

            if (!Number.isFinite(duration) || duration <= 0) return;

            dirty = true;

            // Video corto: riproduzione dall'inizio
            if (duration <= PREVIEW.shortThreshold) {
                video.currentTime = 0;
                play();

                timer = setTimeout(stop, Math.min(duration, PREVIEW.maxDuration) * 1000);

                return;
            }

            // Video lungo: sequenza di spezzoni
            const positions = buildPreviewPositions(duration);
            let index = 0;

            const next = () => {
                if (!active || index >= positions.length) {
                    stop();
                    return;
                }

                onSeeked = () => {
                    onSeeked = null;

                    if (!active) return;

                    play();

                    timer = setTimeout(() => {
                        video.pause();
                        index++;
                        next();
                    }, PREVIEW.segmentDuration * 1000);
                };

                video.addEventListener('seeked', onSeeked, { once: true });
                video.currentTime = positions[index];
            };

            next();
        };

        const enter = () => {
            if (active || !video.paused) return;

            active = true;
            video.muted = true;

            if (video.readyState >= 1) {
                start();
            } else {
                onMeta = () => {
                    onMeta = null;
                    start();
                };

                video.addEventListener('loadedmetadata', onMeta, { once: true });
            }
        };

        return { enter, stop };
    };

    /* ------------------------------------------------------------------ *
     *  Caricamento lazy dei metadati (durata)
     * ------------------------------------------------------------------ */

    const attachSource = (video) => {
        video.preload = 'metadata';
        video.src = video.dataset.src;
    };

    const lazyLoad = (video) => {
        if (!('IntersectionObserver' in window)) {
            attachSource(video);
            return;
        }

        observer ??= new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;

                attachSource(entry.target);
                observer.unobserve(entry.target);
            });
        }, { rootMargin: '200px' });

        observer.observe(video);
    };

    /* ------------------------------------------------------------------ *
     *  Modale
     * ------------------------------------------------------------------ */

    const openModal = (item) => {
        player.poster = getCover(item);
        player.src = item.video;

        modal.showModal();

        player.play().catch(() => { /* autoplay bloccato: l'utente può usare i controlli */ });
    };

    const setupModal = () => {
        modal = getElement(options.modalId);
        player = getElement(options.playerId);

        const closeButton = document.getElementById(options.closeId);
        const { signal } = abort;

        player.controls = true;

        closeButton?.addEventListener('click', () => modal.close(), { signal });

        // click sullo sfondo (backdrop) = chiudi
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.close();
        }, { signal });

        modal.addEventListener('close', () => {
            player.pause();
            player.removeAttribute('src');
            player.removeAttribute('poster');
            player.load();
        }, { signal });
    };

    /* ------------------------------------------------------------------ *
     *  Card
     * ------------------------------------------------------------------ */

    const MEDIA_ERRORS = {
        1: 'caricamento interrotto',
        2: 'errore di rete',
        3: 'errore di decodifica',
        4: 'formato o sorgente non supportati / non trovati'
    };

    // Ritorna la card, oppure null se il video non è utilizzabile (sorgente mancante)
    const buildCard = (item, index) => {
        const type = getType(item);
        const isFree = type !== 'premium' && type !== 'private';
        const hasVideo = !isBlank(item.video);
        const title = isBlank(item.title) ? '' : String(item.title);
        const label = `dataVideo[${index}] "${title || 'senza titolo'}"`;

        if (!hasVideo) {
            console.error(`[VideoRM] ${label} (${type}) ignorato: sorgente ("video") mancante.`);
            return null;
        }

        const card = cardTpl.content.firstElementChild.cloneNode(true);
        const video = card.querySelector('video');
        const badge = card.querySelector('.badge-text');
        const durationEl = card.querySelector('.duration');

        // textContent: nessun rischio di HTML injection dal titolo
        card.querySelector('.title-text').textContent = title;
        card.dataset.type = type;
        video.poster = getCover(item);

        if (type === 'premium') {
            badge.innerHTML = '<span class="crown"></span> Premium';
            video.classList.add('premium');
        }

        if (type === 'private') {
            badge.innerHTML = '<span class="shield"></span> Privato';

            video.insertAdjacentHTML('afterend', `
                <div class="private-cover">
                    <span class="shield private-shield"></span>
                    <div class="private-title">Video privato</div>
                    <div class="private-subtitle">Contenuto riservato</div>
                </div>
            `);
        }

        if (hasVideo) {
            video.dataset.src = item.video;
            lazyLoad(video);
        }

        video.addEventListener('loadedmetadata', () => {
            durationEl.textContent = formatTime(video.duration);
        });

        // Anteprima: esiste solo per i video free
        let preview = null;

        // Caricamento fallito (qualsiasi tipologia): card rimossa e errore loggato
        video.addEventListener('error', () => {
            const err = video.error;
            const reason = MEDIA_ERRORS[err?.code] ?? 'errore sconosciuto';

            console.error(`[VideoRM] ${label} (${type}) rimosso: ${reason} (${item.video})`, err?.message || '');

            if (preview) {
                preview.stop();
                stoppers.delete(preview.stop);
            }

            observer?.unobserve(video);
            card.remove();

            if (!container.querySelector('.vds')) showEmpty();
        });

        // Solo i video "free" sono cliccabili (per ora)
        if (!isFree) {
            card.setAttribute('aria-disabled', 'true');
            return card;
        }

        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `Riproduci: ${title}`);

        preview = createPreview(video);
        stoppers.add(preview.stop);

        // Anteprima solo con il mouse: su touch il tap apre direttamente il player
        card.addEventListener('pointerenter', (e) => {
            if (e.pointerType === 'mouse') preview.enter();
        });

        card.addEventListener('pointerleave', () => preview.stop());

        const open = () => {
            preview.stop();
            openModal(item);
        };

        card.addEventListener('click', open);

        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
            }
        });

        return card;
    };

    /* ------------------------------------------------------------------ *
     *  Rendering
     * ------------------------------------------------------------------ */

    const cleanup = () => {
        stoppers.forEach((stop) => stop());
        stoppers.clear();

        observer?.disconnect();
        observer = null;
    };

    const showEmpty = () => {
        container.innerHTML = '<div class="vds-empty">Nessun video disponibile</div>';
    };

    const render = (items = options.dataVideo) => {
        cleanup();

        options.dataVideo = Array.isArray(items) ? items : [];

        if (options.dataVideo.length === 0) {
            showEmpty();
            return;
        }

        const fragment = document.createDocumentFragment();

        options.dataVideo.forEach((item, index) => {
            const type = getType(item);

            if (type === 'premium' && !options.showPremium) return;
            if (type === 'private' && !options.showPrivate) return;

            const card = buildCard(item, index);

            if (card) fragment.appendChild(card);
        });

        container.replaceChildren(fragment);

        if (!container.querySelector('.vds')) showEmpty();
    };

    const destroy = () => {
        abort.abort();
        cleanup();
        container?.replaceChildren();
    };

    /* ------------------------------------------------------------------ *
     *  Init
     * ------------------------------------------------------------------ */

    try {
        container = getElement(options.contentId);

        if (container.nodeName.toLowerCase() !== 'div') throw new Error('Need a DIV to draw boxes');

        setupModal();
        render();
    } catch (e) {
        console.error(e.message);
    }

    return { render, destroy };
};
