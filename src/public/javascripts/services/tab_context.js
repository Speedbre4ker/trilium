import treeService from "./tree.js";
import protectedSessionHolder from "./protected_session_holder.js";
import server from "./server.js";
import bundleService from "./bundle.js";
import Attributes from "./attributes.js";
import treeUtils from "./tree_utils.js";
import utils from "./utils.js";
import NoteTypeContext from "./note_type.js";
import noteDetailService from "./note_detail.js";
import protectedSessionService from "./protected_session.js";
import optionsService from "./options.js";
import linkService from "./link.js";
import Sidebar from "./sidebar.js";

const $tabContentsContainer = $("#note-tab-container");

const componentClasses = {
    'empty': "./note_detail_empty.js",
    'text': "./note_detail_text.js",
    'code': "./note_detail_code.js",
    'file': "./note_detail_file.js",
    'image': "./note_detail_image.js",
    'search': "./note_detail_search.js",
    'render': "./note_detail_render.js",
    'relation-map': "./note_detail_relation_map.js",
    'protected-session': "./note_detail_protected_session.js"
};

let showSidebarInNewTab = true;

optionsService.addLoadListener(options => {
    showSidebarInNewTab = options.is('showSidebarInNewTab');
});

class TabContext {
    /**
     * @param {TabRow} tabRow
     * @param {object} state
     */
    constructor(tabRow, state = {}) {
        this.tabRow = tabRow;
        this.tabId = state.tabId || utils.randomString(4);
        this.$tab = $(this.tabRow.addTab(this.tabId));

        this.$tabContent = $(".note-tab-content-template").clone();
        this.$tabContent.removeClass('note-tab-content-template');
        this.$tabContent.attr('data-tab-id', this.tabId);
        this.$tabContent.hide();

        $tabContentsContainer.append(this.$tabContent);

        this.$noteTitle = this.$tabContent.find(".note-title");
        this.$noteTitleRow = this.$tabContent.find(".note-title-row");
        this.$notePathList = this.$tabContent.find(".note-path-list");
        this.$notePathCount = this.$tabContent.find(".note-path-count");
        this.$noteDetailComponents = this.$tabContent.find(".note-detail-component");
        this.$childrenOverview = this.$tabContent.find(".children-overview");
        this.$scriptArea = this.$tabContent.find(".note-detail-script-area");
        this.$savedIndicator = this.$tabContent.find(".saved-indicator");
        this.noteChangeDisabled = false;
        this.isNoteChanged = false;
        this.attributes = new Attributes(this);

        if (utils.isDesktop()) {
            const sidebarState = state.sidebar || {
                visible: showSidebarInNewTab
            };

            this.sidebar = new Sidebar(this, sidebarState);
            this.noteType = new NoteTypeContext(this);
        }

        this.components = {};

        this.$noteTitle.on('input', () => {
            if (!this.note) {
                return;
            }

            this.noteChanged();

            this.note.title = this.$noteTitle.val();

            this.tabRow.updateTab(this.$tab[0], {title: this.note.title});
            treeService.setNoteTitle(this.noteId, this.note.title);

            this.setTitleBar();
        });

        if (utils.isDesktop()) {
            // keyboard plugin is not loaded in mobile
            utils.bindElShortcut(this.$noteTitle, 'return', () => {
                this.getComponent().focus();

                return false; // to not propagate the enter into the editor (causes issues with codemirror)
            });
        }

        this.$protectButton = this.$tabContent.find(".protect-button");
        this.$protectButton.click(protectedSessionService.protectNoteAndSendToServer);

        this.$unprotectButton = this.$tabContent.find(".unprotect-button");
        this.$unprotectButton.click(protectedSessionService.unprotectNoteAndSendToServer);

        console.debug(`Created note tab ${this.tabId}`);
    }

    async setNote(note, notePath) {
        this.noteId = note.noteId;
        this.notePath = notePath;
        /** @property {NoteFull} */
        this.note = note;
        this.tabRow.updateTab(this.$tab[0], {title: note.title});

        this.attributes.invalidateAttributes();

        await this.initComponent();

        this.setupClasses();

        this.setCurrentNotePathToHash();

        this.setTitleBar();

        this.closeAutocomplete(); // esp. on windows autocomplete is not getting closed automatically

        setTimeout(async () => {
            // we include the note into recent list only if the user stayed on the note at least 5 seconds
            if (notePath && notePath === this.notePath) {
                await server.post('recent-notes', {
                    noteId: this.noteId,
                    notePath: this.notePath
                });
            }
        }, 5000);

        this.showPaths();

        if (this.sidebar) {
            this.sidebar.noteLoaded(); // load async
        }

        console.debug(`Switched tab ${this.tabId} to ${this.noteId}`);
    }

    show() {
        this.$tabContent.show();
        this.setCurrentNotePathToHash();
        this.setTitleBar();
        this.getComponent().show();
    }

    setTitleBar() {
        if (!this.$tabContent.is(":visible")) {
            return;
        }

        document.title = "Trilium Notes";

        if (this.note) {
            // it helps navigating in history if note title is included in the title
            document.title += " - " + this.note.title;
        }
    }

    hide() {
        this.$tabContent.hide();
    }

    setCurrentNotePathToHash() {
        if (this.$tab[0] === this.tabRow.activeTabEl) {
            document.location.hash = (this.notePath || "") + "-" + this.tabId;
        }
    }

    setupClasses() {
        for (const clazz of Array.from(this.$tab[0].classList)) { // create copy to safely iterate over while removing classes
            if (clazz !== 'note-tab') {
                this.$tab.removeClass(clazz);
            }
        }

        for (const clazz of Array.from(this.$tabContent[0].classList)) { // create copy to safely iterate over while removing classes
            if (clazz !== 'note-tab-content') {
                this.$tabContent.removeClass(clazz);
            }
        }

        this.$tab.addClass(this.note.cssClass);
        this.$tab.addClass(utils.getNoteTypeClass(this.note.type));
        this.$tab.addClass(utils.getMimeTypeClass(this.note.mime));

        this.$tabContent.addClass(this.note.cssClass);
        this.$tabContent.addClass(utils.getNoteTypeClass(this.note.type));
        this.$tabContent.addClass(utils.getMimeTypeClass(this.note.mime));

        this.$noteTitleRow.show(); // might be hidden from empty detail
        this.$tabContent.toggleClass("protected", this.note.isProtected);
        this.$protectButton.toggleClass("active", this.note.isProtected);
        this.$protectButton.prop("disabled", this.note.isProtected);
        this.$unprotectButton.toggleClass("active", !this.note.isProtected);
        this.$unprotectButton.prop("disabled", !this.note.isProtected || !protectedSessionHolder.isProtectedSessionAvailable());
    }

    async initComponent() {
        const type = this.getComponentType();

        if (!(type in this.components)) {
            const clazz = await import(componentClasses[type]);

            this.components[type] = new clazz.default(this);
        }
    }

    getComponent() {
        const type = this.getComponentType();

        return this.components[type];
    }

    getComponentType() {
        let type;

        if (this.note) {
            type = this.note.type;

            if (this.note.isProtected) {
                if (protectedSessionHolder.isProtectedSessionAvailable()) {
                    protectedSessionHolder.touchProtectedSession();
                } else {
                    type = 'protected-session';

                    // user shouldn't be able to edit note title
                    this.$noteTitle.prop("readonly", true);
                }
            }
        } else {
            type = 'empty';
        }
        return type;
    }

    async activate() {
        await this.tabRow.activateTab(this.$tab[0]);
    }

    async saveNote() {
        if (this.note.isProtected && !protectedSessionHolder.isProtectedSessionAvailable()) {
            return;
        }

        this.note.title = this.$noteTitle.val();
        this.note.content = this.getComponent().getContent();

        // it's important to set the flag back to false immediatelly after retrieving title and content
        // otherwise we might overwrite another change (especially async code)
        this.isNoteChanged = false;

        treeService.setNoteTitle(this.note.noteId, this.note.title);

        const resp = await server.put('notes/' + this.note.noteId, this.note.dto);

        this.note.dateModified = resp.dateModified;
        this.note.utcDateModified = resp.utcDateModified;

        if (this.note.isProtected) {
            protectedSessionHolder.touchProtectedSession();
        }

        this.$savedIndicator.fadeIn();

        // run async
        bundleService.executeRelationBundles(this.note, 'runOnNoteChange', this);
    }

    async saveNoteIfChanged() {
        if (this.isNoteChanged) {
            await this.saveNote();

            noteDetailService.refreshTabs(this.tabId, this.noteId);
        }
    }

    noteChanged() {
        if (this.noteChangeDisabled) {
            return;
        }

        this.isNoteChanged = true;

        this.$savedIndicator.fadeOut();
    }

    async showChildrenOverview() {
        const attributes = await this.attributes.getAttributes();
        const hideChildrenOverview = attributes.some(attr => attr.type === 'label' && attr.name === 'hideChildrenOverview')
            || this.note.type === 'relation-map'
            || this.note.type === 'image'
            || this.note.type === 'file';

        if (hideChildrenOverview) {
            this.$childrenOverview.hide();
            return;
        }

        this.$childrenOverview.empty();

        for (const childBranch of await this.note.getChildBranches()) {
            const link = $('<a>', {
                href: 'javascript:',
                text: await treeUtils.getNoteTitle(childBranch.noteId, childBranch.parentNoteId)
            }).attr('data-action', 'note').attr('data-note-path', this.notePath + '/' + childBranch.noteId);

            const childEl = $('<div class="child-overview-item">').html(link);
            this.$childrenOverview.append(childEl);
        }

        this.$childrenOverview.show();
    }

    async addPath(notePath, isCurrent) {
        const title = await treeUtils.getNotePathTitle(notePath);

        const noteLink = await linkService.createNoteLink(notePath, title);

        noteLink
            .addClass("no-tooltip-preview")
            .addClass("dropdown-item");

        if (isCurrent) {
            noteLink.addClass("current");
        }

        this.$notePathList.append(noteLink);
    }

    async showPaths() {
        if (this.note.noteId === 'root') {
            // root doesn't have any parent, but it's still technically 1 path

            this.$notePathCount.html("1 path");

            this.$notePathList.empty();

            await this.addPath('root', true);
        }
        else {
            const parents = await this.note.getParentNotes();

            this.$notePathCount.html(parents.length + " path" + (parents.length > 1 ? "s" : ""));
            this.$notePathList.empty();

            const pathSegments = this.notePath.split("/");
            const activeNoteParentNoteId = pathSegments[pathSegments.length - 2]; // we know this is not root so there must be a parent

            for (const parentNote of parents) {
                const parentNotePath = await treeService.getSomeNotePath(parentNote);
                // this is to avoid having root notes leading '/'
                const notePath = parentNotePath ? (parentNotePath + '/' + this.noteId) : this.noteId;
                const isCurrent = activeNoteParentNoteId === parentNote.noteId;

                await this.addPath(notePath, isCurrent);
            }
        }
    }

    closeAutocomplete() {
        if (utils.isDesktop()) {
            this.$tabContent.find('.aa-input').autocomplete('close');
        }
    }

    syncDataReceived(syncData) {
        this.attributes.syncDataReceived(syncData);

        if (this.sidebar) {
            this.sidebar.syncDataReceived(syncData);
        }
    }

    getTabState() {
        if (!this.notePath) {
            return null;
        }

        return {
            tabId: this.tabId,
            notePath: this.notePath,
            active: this.tabRow.activeTabEl === this.$tab[0],
            sidebar: this.sidebar && this.sidebar.getSidebarState()
        }
    }

    stateChanged() {
        noteDetailService.openTabsChanged();
    }
}

export default TabContext;