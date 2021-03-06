import Ember from 'ember';
import moment from 'moment';
import { Mixin, Debug } from '../mixins/debugger';
import { stringify } from '../utils/json';

export default Ember.Service.extend(Mixin, {
    store: Ember.inject.service(),

    oa2: {
        clientID: 'b5f61636-8c63-4a7c-b4a3-6af6df33ad15',
        base: 'https://login.microsoftonline.com/common',
        authUrl: '/oauth2/v2.0/authorize',
        tokenUrl: '/oauth2/v2.0/token',
        scopes: ['openid', 'https://outlook.office.com/Calendars.read', 'profile']
    },

    api: {
        preferTrack: {
            Prefer: 'odata.track-changes, odata.maxpagesize=200'
        },
        prefer: {
            Prefer: 'odata.maxpagesize=200'
        },
        base: 'https://outlook.office.com/api/v2.0/'
    },

    init() {
        this._super(...arguments);
        this.set('debugger', new Debug('Sync Office'));
    },

    addAccount() {
        return new Promise((resolve, reject) => {
            this.authenticate().then((response) => {
                if (!response || !response.id_token) return;

                const newAccount = this.get('store').createRecord('account', {
                    name: 'Office 365',
                    username: this._getEmailFromToken(response.id_token),
                    strategy: 'office',
                    oauth: response
                }).save();

                resolve(newAccount);
            }).catch(err => reject(err));
        });
    },

    getCalendarView(startDate, endDate, account, syncOptions) {
        return new Promise((resolve) => {
            const uri = require('urijs');

            const oauth = account.get('oauth');
            const username = account.get('username');

            const start = moment(startDate).toISOString();
            const end = moment(endDate).toISOString();

            const fetchURL = uri(`${this.api.base}users/${username}/calendarview`);
            fetchURL.setQuery({
                startDateTime: start,
                endDateTime: end
            });

            return this._fetchEvents(fetchURL.toString(), oauth.access_token, syncOptions, account)
                .then((events, deltaToken) => {
                    resolve(events, deltaToken);
                });
        });
    },

    authenticate(existingUser) {
        return new Promise((resolve, reject) => {
            const BrowserWindow = require('electron').remote.BrowserWindow;
            const authUrl = this._makeAuthURI(existingUser);

            let authWindow = new BrowserWindow({
                width: 800,
                height: 600,
                show: false,
                'node-integration': false
            });

            authWindow.loadURL(authUrl.toString());

            if (!existingUser) {
                authWindow.show();
            }

            authWindow.webContents.on('will-navigate', (event, url) => {
                this._handleCallback(url, authWindow, resolve, reject);
            });
            authWindow.webContents.on('did-get-redirect-request', (event, oldUrl, newUrl) => {
                this._handleCallback(newUrl, authWindow, resolve, reject);
            });

            authWindow.on('close', () => {
                authWindow = null;
                reject();
            }, false);
        });
    },

    /**
     * Makes a URI to authenticate against O365, depending on configuration
     * and whether or not we have an existing user
     * @param  {string} existingUser - Email address of the "existing user"
     * @return {Object/uri.js}       - uri.js url object
     */
    _makeAuthURI(existingUser) {
        const uri = require('urijs');
        const authUrl = uri(this.oa2.base + this.oa2.authUrl);

        authUrl.setQuery({
            redirect_uri: 'https://redirect.butter',
            scope: this.oa2.scopes.join(' '),
            client_id: this.oa2.clientID
        });

        if (this.oa2.clientSecret) {
            authUrl.setQuery({
                response_type: 'code'
            });
        } else {
            authUrl.setQuery({
                response_type: 'id_token token',
                response_mode: 'fragment',
                state: '12345',
                nonce: '678910'
            });
        }

        if (existingUser) {
            // Todo: DomainHint is probably only correct for O365
            authUrl.setQuery({
                prompt: 'none',
                login_hint: existingUser,
                domain_hint: 'organizations'
            });
        }

        return authUrl;
    },

    _getEmailFromToken(token) {
        if (!token) return null;

        const tokenParts = token.split('.');
        const encodedToken = new Buffer(tokenParts[1].replace('-', '_').replace('+', '/'), 'base64');
        const decodedToken = encodedToken.toString();
        const jwt = JSON.parse(decodedToken);

        return jwt.preferred_username;
    },

    _fetchEvents(url, token, syncOptions, account) {
        return new Promise((resolve, reject) => {
            const uri = require('urijs');

            const events = [];
            const occurences = [];
            const masters = [];
            const firstUrl = uri(url);
            let deltaToken = account.get('sync.deltaToken');

            if (syncOptions.useDelta && deltaToken) {
                firstUrl.setQuery('deltatoken', deltaToken);
            }

            const fetch = (_url, _token, _trackChanges) => {
                const header = _trackChanges ? this.api.preferTrack : this.api.prefer;
                this.log('Fetching events');

                return this._makeApiCall(_url, _token, header).then((response) => {
                    if (!response || !response.ok || !response.body) reject(response);
                    response.body.value.forEach(item => {
                        if (item.Type === 'SeriesMaster') {
                            masters.push(item);
                        }

                        if (item.Type === 'Occurrence') {
                            occurences.push(item);
                            return;
                        }

                        if (item.reason && item.reason === 'deleted') {
                            // Delta Update, event has been deleted
                            // Probably no action required?
                            return;
                        }

                        events.push(this._makeEvent(item));
                    });

                    if (response.body['@odata.nextLink']) {
                        return fetch(response.body['@odata.nextLink'], _token, false);
                    } else if (syncOptions.trackChanges && response.body['@odata.deltaLink']) {
                        deltaToken = this._findDeltaToken(response) || deltaToken;
                        return fetch(response.body['@odata.deltaLink'], _token, false);
                    }

                    // Process all instances before returning
                    occurences.forEach(inst => events.push(this._makeEventFromOccurence(inst, masters)));

                    this.log('Done fetching events');
                    return resolve({
                        events,
                        deltaToken
                    });
                }).catch((err, response) => {
                    const er = err.response || {};

                    if (er.statusCode && er.statusCode === 401) {
                        this.log('Office 365: Token probably expired, fetching new token');
                        return this._reauthenticate(account)
                            .then(newToken => fetch(_url, newToken))
                            .catch(error => {
                                this.log('Office 365: Attempted to getCalendarView', error);
                            });
                    } else if (er.statusCode && er.statusCode === 410) {
                        this.log('Office 365: Sync Status not found, refetching');
                        return fetch(url, _token, true);
                    }

                    this.log('Office 365: Unknown error during api call:');
                    this.log(err, response);
                });
            };

            fetch(firstUrl.toString(), token, syncOptions.trackChanges);
        });
    },

    _makeEvent(ev) {
        const start = moment(new Date(ev.Start.DateTime + 'Z'));
        const end = moment(new Date(ev.End.DateTime + 'Z'));
        const isAllDay = (ev.IsAllDay || !start.isSame(end, 'day'));
        const location = (ev.Location) ? ev.Location.DisplayName : '';
        const organizer = (ev.Organizer && ev.Organizer.EmailAddress) ? ev.Organizer.EmailAddress : '';
        const _participants = this._makeParticipants(ev);

        return {
            start: start.format(),
            end: end.format(),
            title: ev.Subject,
            providerId: ev.Id,
            body: ev.Body.Content,
            bodyPreview: ev.BodyPreview,
            bodyType: ev.Body.ContentType,
            showAs: ev.ShowAs,
            isEditable: false,
            isOrganizer: ev.IsOrganizer,
            isReminderOn: ev.IsReminderOn,
            isCancelled: ev.IsCancelled,
            _participants,
            organizer,
            location,
            isAllDay
        };
    },

    _makeParticipants(ev) {
        if (ev.Attendees && ev.Attendees.length && ev.Attendees.length > 0) {
            const result = [];

            for (let i = 0; i < ev.Attendees.length; i++) {
                result.push({
                    name: ev.Attendees[i].EmailAddress.Name,
                    email: ev.Attendees[i].EmailAddress.Address
                });
            }

            return stringify(result);
        }
        return '{[]}';
    },

    _makeEventFromOccurence(occurence, masters) {
        const master = masters.find((item) => (item.Id === occurence.SeriesMasterId));
        const _occurence = occurence;

        if (master) {
            _occurence.Subject = master.Subject;
            _occurence.Body = master.Body;
            _occurence.BodyPreview = master.BodyPreview;
            _occurence.IsAllDay = master.IsAllDay;
        }

        return this._makeEvent(_occurence);
    },

    /**
     * Takes a O365 API response and extracts the deltaToken, if present
     * @param  {Object} response O365 API Response
     * @return {string} deltaToken
     */
    _findDeltaToken(response) {
        if (!response || !response.body['@odata.deltaLink']) return null;

        const tokenPosition = response.body['@odata.deltaLink'].lastIndexOf('deltatoken=');
        const token = response.body['@odata.deltaLink'].slice(tokenPosition + 11);

        // If the token length is fishy, let's not return anything
        return (token.length === 32) ? token : null;
    },

    _makeApiCall(url, token, headerExtras) {
        return new Promise((resolve, reject) => {
            const superagent = require('superagent');
            const header = {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json',
                'User-Agent': 'butter/dev'
            };

            if (headerExtras) {
                Ember.$.extend(header, headerExtras);
            }

            superagent
                .get(url)
                .set(header)
                .end((error, response) => {
                    if (response && response.ok) {
                        resolve(response);
                    } else {
                        reject({
                            error,
                            response
                        });
                    }
                });
        });
    },

    _requestToken(code) {
        const tokenUrl = this.oa2.base + this.oa2.tokenUrl;
        const superagent = require('superagent');

        return new Promise((resolve, reject) => {
            superagent
                .post(tokenUrl)
                .type('form')
                .send({
                  client_id: this.oa2.clientID,
                  client_secret: this.oa2.clientSecret,
                  code: code,
                  grant_type: 'authorization_code'
                })
                .end((error, response) => {
                    if (response && response.ok && response.body) {
                        resolve(response.body);
                    } else {
                        reject({
                            error,
                            response
                        });
                    }
                });
        });
    },

    _handleCallback(url, win, resolve, reject) {
        const rawCode = /code=([^&]*)/.exec(url) || null;
        const rawToken = /access_token=([^&]*)/.exec(url) || null;
        const rawId = /id_token=([^&]*)/.exec(url) || null;
        const code = (rawCode && rawCode.length > 1) ? rawCode[1] : null;
        const token = (rawToken && rawToken.length > 1) ? rawToken[1] : null;
        const id = (rawId && rawId.length > 1) ? rawId[1] : null;
        const err = /\?error=(.+)$/.exec(url);

        if (code || err || token) {
            win.destroy();

            if (code) {
                this._requestToken(code)
                    .then((response) => {
                        const _response = response;
                        _response.code = code;
                        resolve(_response);
                    });
            } else if (token) {
                resolve({
                    id_token: id,
                    access_token: token
                });
            } else if (err) {
                reject(err);
            }
        }
    },

    /**
     * Reauthenticates a given account, essentially quietly opening a new
     * window and hoping that O365/Microsoft lets us in without the user
     * having to confirm anything
     * @param  {object} account O365 account to fetch new token for
     * @return {Promise}
     */
    _reauthenticate(account) {
        return new Promise((resolve, reject) => {
            this.authenticate(account.get('username')).then((response) => {
                if (!response || !response.access_token) reject('No response received');

                account.setProperties({
                    name: 'Office 365',
                    username: response.id_token ? this._getEmailFromToken(response.id_token) : 'O365',
                    strategy: 'office',
                    oauth: response
                });
                account.save();

                resolve(response.access_token);
            }).catch((err) => {
                console.log(err);
                reject(err);
            });
        });
    }
});
