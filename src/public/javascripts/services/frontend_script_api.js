import treeService from './tree.js';
import server from './server.js';
import utils from './utils.js';
import infoService from './info.js';
import linkService from './link.js';
import treeCache from './tree_cache.js';
import noteDetailService from './note_detail.js';
import noteTooltipService from './note_tooltip.js';
import protectedSessionService from './protected_session.js';
import dateNotesService from './date_notes.js';
import StandardWidget from '../widgets/standard_widget.js';

/**
 * This is the main frontend API interface for scripts. It's published in the local "api" object.
 *
 * @constructor
 * @hideconstructor
 */
function FrontendScriptApi(startNote, currentNote, originEntity = null, tabContext = null) {
    const $pluginButtons = $("#plugin-buttons");

    /** @property {object} note where script started executing */
    this.startNote = startNote;
    /** @property {object} note where script is currently executing */
    this.currentNote = currentNote;
    /** @property {object|null} entity whose event triggered this execution */
    this.originEntity = originEntity;

    // to keep consistency with backend API
    this.dayjs = dayjs;

    /** @property {TabContext|null} - experimental! */
    this.tabContext = tabContext;

    /** @property {StandardWidget} */
    this.StandardWidget = StandardWidget;

    /**
     * Activates note in the tree and in the note detail.
     *
     * @method
     * @param {string} notePath (or noteId)
     * @returns {Promise<void>}
     */
    this.activateNote = async (notePath, noteLoadedListener) => {
        await treeService.activateNote(notePath, async () => {
            await treeService.scrollToActiveNote();

            if (noteLoadedListener) {
                noteLoadedListener();
            }
        });
    };

    /**
     * Activates newly created note. Compared to this.activateNote() also refreshes tree.
     *
     * @param {string} notePath (or noteId)
     * @return {Promise<void>}
     */
    this.activateNewNote = async notePath => {
        await treeService.reload();

        await treeService.activateNote(notePath, noteDetailService.focusAndSelectTitle);
    };

    /**
     * @typedef {Object} ToolbarButtonOptions
     * @property {string} title
     * @property {string} [icon] - name of the JAM icon to be used (e.g. "clock" for "jam-clock" icon)
     * @property {function} action - callback handling the click on the button
     * @property {string} [shortcut] - keyboard shortcut for the button, e.g. "alt+t"
     */

    /**
     * Adds new button the the plugin area.
     *
     * @param {ToolbarButtonOptions} opts
     */
    this.addButtonToToolbar = opts => {
        const buttonId = "toolbar-button-" + opts.title.replace(/[^a-zA-Z0-9]/g, "-");

        const button = $('<button>')
            .addClass("btn btn-sm")
            .click(opts.action);

        if (opts.icon) {
            button.append($("<span>").addClass("jam jam-" + opts.icon))
                  .append("&nbsp;");
        }

        button.append($("<span>").text(opts.title));

        button.attr('id', buttonId);

        if ($("#" + buttonId).replaceWith(button).length === 0) {
            $pluginButtons.append(button);
        }

        if (opts.shortcut) {
            utils.bindGlobalShortcut(opts.shortcut, opts.action);

            button.attr("title", "Shortcut " + opts.shortcut);
        }
    };

    function prepareParams(params) {
        if (!params) {
            return params;
        }

        return params.map(p => {
            if (typeof p === "function") {
                return "!@#Function: " + p.toString();
            }
            else {
                return p;
            }
        });
    }

    /**
     * Executes given anonymous function on the server.
     * Internally this serializes the anonymous function into string and sends it to backend via AJAX.
     *
     * @param {string} script - script to be executed on the backend
     * @param {Array.<?>} params - list of parameters to the anonymous function to be send to backend
     * @return {Promise<*>} return value of the executed function on the backend
     */
    this.runOnServer = async (script, params = []) => {
        if (typeof script === "function") {
            script = script.toString();
        }

        const ret = await server.post('script/exec', {
            script: script,
            params: prepareParams(params),
            startNoteId: startNote.noteId,
            currentNoteId: currentNote.noteId,
            originEntityName: "notes", // currently there's no other entity on frontend which can trigger event
            originEntityId: originEntity ? originEntity.noteId : null
        });

        if (ret.success) {
            return ret.executionResult;
        }
        else {
            throw new Error("server error: " + ret.error);
        }
    };

    /**
     * This is a powerful search method - you can search by attributes and their values, e.g.:
     * "@dateModified =* MONTH AND @log". See full documentation for all options at: https://github.com/zadam/trilium/wiki/Search
     *
     * @method
     * @param {string} searchString
     * @returns {Promise<NoteShort[]>}
     */
    this.searchForNotes = async searchString => {
        const noteIds = await this.runOnServer(async searchString => {
            const notes = await api.searchForNotes(searchString);

            return notes.map(note => note.noteId);
        }, [searchString]);

        return await treeCache.getNotes(noteIds);
    };

    /**
     * This is a powerful search method - you can search by attributes and their values, e.g.:
     * "@dateModified =* MONTH AND @log". See full documentation for all options at: https://github.com/zadam/trilium/wiki/Search
     *
     * @method
     * @param {string} searchString
     * @returns {Promise<NoteShort|null>}
     */
    this.searchForNote = async searchString => {
        const notes = await this.searchForNotes(searchString);

        return notes.length > 0 ? notes[0] : null;
    };

    /**
     * Returns note by given noteId. If note is missing from cache, it's loaded.
     **
     * @param {string} noteId
     * @return {Promise<NoteShort>}
     */
    this.getNote = async noteId => await treeCache.getNote(noteId);

    /**
     * Returns list of notes. If note is missing from cache, it's loaded.
     *
     * This is often used to bulk-fill the cache with notes which would have to be picked one by one
     * otherwise (by e.g. createNoteLink())
     *
     * @param {string[]} noteIds
     * @param {boolean} [silentNotFoundError] - don't report error if the note is not found
     * @return {Promise<NoteShort[]>}
     */
    this.getNotes = async (noteIds, silentNotFoundError = false) => await treeCache.getNotes(noteIds, silentNotFoundError);

    /**
     * @param {string} noteId
     * @method
     */
    this.reloadChildren = async noteId => await treeCache.reloadChildren(noteId);

    /**
     * @param {string} noteId
     * @method
     */
    this.reloadParents = async noteId => await treeCache.reloadParents(noteId);

    /**
     * Instance name identifies particular Trilium instance. It can be useful for scripts
     * if some action needs to happen on only one specific instance.
     *
     * @return {string}
     */
    this.getInstanceName = () => window.glob.instanceName;

    /**
     * @method
     * @param {Date} date
     * @returns {string} date in YYYY-MM-DD format
     */
    this.formatDateISO = utils.formatDateISO;

    /**
     * @method
     * @param {string} str
     * @returns {Date} parsed object
     */
    this.parseDate = utils.parseDate;

    /**
     * Show info message to the user.
     *
     * @method
     * @param {string} message
     */
    this.showMessage = infoService.showMessage;

    /**
     * Show error message to the user.
     *
     * @method
     * @param {string} message
     */
    this.showError = infoService.showError;

    /**
     * Refresh tree
     *
     * @method
     * @returns {Promise<void>}
     */
    this.refreshTree = treeService.reload;

    /**
     * Create note link (jQuery object) for given note.
     *
     * @method
     * @param {string} notePath (or noteId)
     * @param {string} [noteTitle] - if not present we'll use note title
     */
    this.createNoteLink = linkService.createNoteLink;

    /**
     * @method
     * @returns {NoteFull} active note (loaded into right pane)
     */
    this.getActiveNote = noteDetailService.getActiveNote;

    /**
     * @method
     * @returns {Promise<string|null>} returns note path of active note or null if there isn't active note
     */
    this.getActiveNotePath = () => {
        const activeTabContext = noteDetailService.getActiveTabContext();

        return activeTabContext ? activeTabContext.notePath : null;
    };

    /**
     * This method checks whether user navigated away from the note from which the scripts has been started.
     * This is necessary because script execution is async and by the time it is finished, the user might have
     * already navigated away from this page - the end result would be that script might return data for the wrong
     * note.
     *
     * @method
     * @return {boolean} returns true if the original note is still loaded, false if user switched to another
     */
    this.isNoteStillActive = () => {
        return this.originEntity.noteId === tabContext.noteId;
    };

    /**
     * @method
     * @param {function} func - callback called on note change as user is typing (not necessarily tied to save event)
     */
    this.onNoteChange = noteDetailService.onNoteChange;

    /**
     * @method
     * @param {object} $el - jquery object on which to setup the tooltip
     */
    this.setupElementTooltip = noteTooltipService.setupElementTooltip;

    /**
     * @method
     */
    this.protectActiveNote = protectedSessionService.protectNoteAndSendToServer;

    /**
     * Returns date-note for today. If it doesn't exist, it is automatically created.
     *
     * @method
     * @return {Promise<NoteShort>}
     */
    this.getTodayNote = dateNotesService.getTodayNote;

    /**
     * Returns date-note. If it doesn't exist, it is automatically created.
     *
     * @method
     * @param {string} date - e.g. "2019-04-29"
     * @return {Promise<NoteShort>}
     */
    this.getDateNote = dateNotesService.getDateNote;

    /**
     * Returns month-note. If it doesn't exist, it is automatically created.
     *
     * @method
     * @param {string} month - e.g. "2019-04"
     * @return {Promise<NoteShort>}
     */
    this.getMonthNote = dateNotesService.getMonthNote;

    /**
     * Returns year-note. If it doesn't exist, it is automatically created.
     *
     * @method
     * @param {string} year - e.g. "2019"
     * @return {Promise<NoteShort>}
     */
    this.getYearNote = dateNotesService.getYearNote;
}

export default FrontendScriptApi;