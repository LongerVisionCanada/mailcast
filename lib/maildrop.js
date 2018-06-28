'use strict';

const SeqIndex = require('seq-index');
const RelaxedBody = require('nodemailer/lib/dkim/relaxed-body');
const MessageSplitter = require('./message-splitter');
const seqIndex = new SeqIndex();
const GridFSBucket = require('mongodb').GridFSBucket;
const uuid = require('uuid');
const os = require('os');
const hostname = os.hostname().toLowerCase();
const addressparser = require('nodemailer/lib/addressparser');
const punycode = require('punycode');

class Maildropper {
    constructor(options) {
        this.options = options || {};
        this.db = options.db;
        this.zone = options.zone;
        this.collection = options.collection;
        this.gfs = options.gfs;

        this.gridstore =
            options.gridstore ||
            new GridFSBucket(this.db.senderDb, {
                bucketName: this.gfs
            });
    }

    // this method mixes streams with callbacks, so no async/await
    push(options, callback) {
        let id = options.id || seqIndex.get();
        let seq = 0;
        let documents = [];

        let envelope = {
            id,

            from: options.from || '',
            to: Array.isArray(options.to) ? options.to : [].concat(options.to || []),

            interface: options.interface || 'maildrop',
            transtype: 'API',
            time: Date.now(),

            dkim: {
                hashAlgo: 'sha256'
            }
        };

        if (options.parentId) {
            envelope.parentId = options.parentId;
        }

        if (options.reason) {
            envelope.reason = options.reason;
        }

        let deliveries = [];

        deliveries = envelope.to.map(to => ({
            to
        }));

        if (!deliveries.length) {
            let err = new Error('No valid recipients');
            err.code = 'ENORECIPIENTS';
            return callback(err);
        }

        let messageSplitter = new MessageSplitter();
        let dkimStream = new RelaxedBody(envelope.dkim);

        messageSplitter.once('headers', headers => {
            envelope.headers = headers;
            this.updateHeaders(envelope);
        });

        dkimStream.on('hash', bodyHash => {
            // store relaxed body hash for signing
            envelope.dkim.bodyHash = bodyHash;
            envelope.bodySize = dkimStream.byteLength;
        });

        messageSplitter.once('error', err => dkimStream.emit('error', err));

        // store stream to queue db
        this.store(id, dkimStream, err => {
            if (err) {
                return callback(err);
            }

            // no streams, can move over to async/await
            let asyncHandler = async () => {
                envelope.headers = envelope.headers.getList();

                try {
                    await this.setMeta(id, envelope);
                } catch (err) {
                    await this.removeMessage(id);
                    throw err;
                }

                let date = new Date();

                for (let i = 0, len = deliveries.length; i < len; i++) {
                    let recipient = deliveries[i];

                    let deliveryZone = options.zone || this.zone || 'default';
                    let recipientDomain = recipient.to.substr(recipient.to.lastIndexOf('@') + 1).replace(/[[\]]/g, '');

                    seq++;
                    let deliverySeq = (seq < 0x100 ? '0' : '') + (seq < 0x10 ? '0' : '') + seq.toString(16);
                    let delivery = {
                        id,
                        seq: deliverySeq,

                        // Actual delivery data
                        domain: recipientDomain,
                        sendingZone: deliveryZone,

                        assigned: 'no',

                        // actual recipient address
                        recipient: recipient.to,

                        locked: false,
                        lockTime: 0,

                        // earliest time to attempt delivery, defaults to now
                        queued: options.sendTime || date,

                        // queued date might change but created should not
                        created: date
                    };

                    if (recipient.http) {
                        delivery.http = recipient.http;
                        delivery.targetUrl = recipient.targetUrl;
                    }

                    documents.push(delivery);
                }

                await this.db.senderDb.collection(this.collection).insertMany(documents, {
                    w: 1,
                    ordered: false
                });

                return callback(null, envelope);
            };

            try {
                asyncHandler();
            } catch (err) {
                return callback(err);
            }
        });
        messageSplitter.pipe(dkimStream);
        return messageSplitter;
    }

    convertAddresses(addresses, withNames, addressList) {
        addressList = addressList || new Map();

        this.flatten(addresses || []).forEach(address => {
            if (address.address) {
                let normalized = this.normalizeAddress(address, withNames);
                let key = typeof normalized === 'string' ? normalized : normalized.address;
                addressList.set(key, normalized);
            } else if (address.group) {
                this.convertAddresses(address.group, withNames, addressList);
            }
        });

        return addressList;
    }

    parseAddressList(headers, key, withNames) {
        return this.parseAddressses(headers.getDecoded(key).map(header => header.value), withNames);
    }

    parseAddressses(headerList, withNames) {
        let map = this.convertAddresses(
            headerList.map(address => {
                if (typeof address === 'string') {
                    address = addressparser(address);
                }
                return address;
            }),
            withNames
        );
        return Array.from(map).map(entry => entry[1]);
    }

    normalizeDomain(domain) {
        domain = domain.toLowerCase().trim();
        try {
            domain = punycode.toASCII(domain);
        } catch (E) {
            // ignore
        }
        return domain;
    }

    // helper function to flatten arrays
    flatten(arr) {
        let flat = [].concat(...arr);
        return flat.some(Array.isArray) ? this.flatten(flat) : flat;
    }

    normalizeAddress(address, withNames) {
        if (typeof address === 'string') {
            address = {
                address
            };
        }
        if (!address || !address.address) {
            return '';
        }
        let user = address.address.substr(0, address.address.lastIndexOf('@'));
        let domain = address.address.substr(address.address.lastIndexOf('@') + 1);
        let addr = user.trim() + '@' + this.normalizeDomain(domain);

        if (withNames) {
            return {
                name: address.name || '',
                address: addr
            };
        }

        return addr;
    }

    updateHeaders(envelope) {
        // Fetch sender and receiver addresses
        envelope.parsedEnvelope = {
            from: this.parseAddressList(envelope.headers, 'from').shift() || false,
            to: this.parseAddressList(envelope.headers, 'to'),
            cc: this.parseAddressList(envelope.headers, 'cc'),
            bcc: this.parseAddressList(envelope.headers, 'bcc'),
            replyTo: this.parseAddressList(envelope.headers, 'reply-to').shift() || false,
            sender: this.parseAddressList(envelope.headers, 'sender').shift() || false
        };

        // Check Message-ID: value. Add if missing
        let mId = envelope.headers.getFirst('message-id');
        if (!mId) {
            mId = '<' + uuid.v4() + '@' + (envelope.from.substr(envelope.from.lastIndexOf('@') + 1) || hostname) + '>';

            envelope.headers.remove('message-id'); // in case there's an empty value
            envelope.headers.add('Message-ID', mId);
        }
        envelope.messageId = mId;

        // Check Date: value. Add if missing or invalid or future date
        let date = envelope.headers.getFirst('date');
        let dateVal = new Date(date);
        if (!date || dateVal.toString() === 'Invalid Date' || dateVal < new Date(1000)) {
            date = new Date().toUTCString().replace(/GMT/, '+0000');
            envelope.headers.remove('date'); // remove old empty or invalid values
            envelope.headers.add('Date', date);
        }

        envelope.date = date;

        // Remove BCC if present
        envelope.headers.remove('bcc');
    }

    // uses streams, so no async/await
    store(id, stream, callback) {
        let returned = false;
        let store = this.gridstore.openUploadStream('message ' + id, {
            fsync: true,
            contentType: 'message/rfc822',
            metadata: {
                created: new Date()
            }
        });

        stream.once('error', err => {
            if (returned) {
                return;
            }
            returned = true;

            store.once('finish', () => {
                this.removeMessage(id)
                    .then(() => callback(err))
                    .catch(() => callback(err));
            });

            store.end();
        });

        store.once('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            callback(err);
        });

        store.once('finish', () => {
            if (returned) {
                return;
            }
            returned = true;

            return callback(null, id);
        });

        stream.pipe(store);
    }

    async removeMessage(id) {
        return await this.gridstore.unlink('message ' + id);
    }

    async setMeta(id, data) {
        await this.db.senderDb.collection(this.gfs + '.files').updateOne(
            {
                filename: 'message ' + id
            },
            {
                $set: {
                    'metadata.data': data
                }
            }
        );
    }
}

module.exports = Maildropper;
