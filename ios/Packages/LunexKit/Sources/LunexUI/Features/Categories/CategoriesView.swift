import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// Expense and income categories: top-level ones in the user's order (drag to reorder) with their
/// subcategories under them, then the archive. System categories can be archived and moved;
/// own ones also renamed, recolored, nested and deleted.
struct CategoriesView: View {
    @Environment(Catalog.self) private var catalog
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer

    @Query(filter: #Predicate<CategoryRecord> { $0.deletedAt == nil }, sort: \CategoryRecord.sortOrder)
    private var categories: [CategoryRecord]
    @State private var kind = CategoryKind.expense
    @State private var editor: CategoryEditorTarget?
    @State private var isReordering = false

    var body: some View {
        let ofKind = categories.filter { $0.type == kind.rawValue }
        let top = ofKind.filter { $0.parentId == nil && !$0.isArchived }
        let children = Dictionary(grouping: ofKind.filter { $0.parentId != nil && !$0.isArchived }) { $0.parentId ?? UUID() }
        let archived = ofKind.filter(\.isArchived)

        List {
            Section {
                Picker(localizer("categories.kind"), selection: $kind) {
                    Text(localizer("categories.expense")).tag(CategoryKind.expense)
                    Text(localizer("categories.income")).tag(CategoryKind.income)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            Section {
                ForEach(top) { category in
                    CategoryGroupRow(category: category, children: children[category.id] ?? []) { editor = .edit($0) }
                        .listRowBackground(LunexColor.surface)
                }
                .onMove { from, to in move(top, from: from, to: to) }
            } footer: {
                Text(localizer("categories.hint"))
            }
            if !archived.isEmpty {
                Section {
                    ForEach(archived) { category in
                        Button { editor = .edit(category.id) } label: {
                            CategoryLine(category: category, isChild: false)
                                .opacity(0.6)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(LunexColor.surface)
                    }
                } header: {
                    SectionLabel(localizer("categories.archive"))
                }
            }
        }
        .groupedLists()
        .scrollContentBackground(.hidden)
        .background(LunexColor.paper)
        .reordering(isReordering)
        .navigationTitle(localizer("categories.title"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(localizer(isReordering ? "add.done" : "common.reorder")) {
                    withAnimation { isReordering.toggle() }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button(localizer("categories.new"), systemImage: "plus") { editor = .new(kind) }
                    .disabled(isReordering)
            }
        }
        .sheet(item: $editor) { target in
            CategoryEditor(target: target)
        }
    }

    private func move(_ top: [CategoryRecord], from: IndexSet, to: Int) {
        var ids = top.map(\.id)
        ids.move(fromOffsets: from, toOffset: to)
        do {
            try catalog.reorderCategories(ids)
        } catch {
            toasts.show(localizer.catalogMessage(error))
        }
    }
}

/// A top-level category with its subcategories; the group moves as one row.
private struct CategoryGroupRow: View {
    let category: CategoryRecord
    let children: [CategoryRecord]
    let open: (UUID) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Button { open(category.id) } label: {
                CategoryLine(category: category, isChild: false)
            }
            .buttonStyle(.borderless)
            ForEach(children) { child in
                Divider()
                    .overlay(LunexColor.line)
                    .padding(.leading, LunexTheme.Size.iconWell + LunexTheme.Spacing.space3)
                Button { open(child.id) } label: {
                    CategoryLine(category: child, isChild: true)
                }
                .buttonStyle(.borderless)
            }
        }
    }
}

struct CategoryLine: View {
    let category: CategoryRecord
    let isChild: Bool
    @Environment(Localizer.self) private var localizer

    var body: some View {
        HStack(spacing: LunexTheme.Spacing.space3) {
            if isChild {
                Color.clear.frame(width: LunexTheme.Size.iconWell - 32)
            }
            SymbolWell(symbol: category.outlineIcon, color: category.color, size: isChild ? 32 : LunexTheme.Size.iconWell)
            Text(category.displayName(language: localizer.language.rawValue))
                .lunexText(isChild ? .body : .bodyStrong)
                .foregroundStyle(LunexColor.ink)
                .lineLimit(1)
            Spacer(minLength: LunexTheme.Spacing.space2)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(LunexColor.inkFaint)
        }
        .frame(minHeight: isChild ? 48 : LunexTheme.Size.rowHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Editor

enum CategoryEditorTarget: Identifiable, Hashable {
    case new(CategoryKind)
    case edit(UUID)

    var id: String {
        switch self {
        case let .new(kind): "new-\(kind.rawValue)"
        case let .edit(id): id.uuidString
        }
    }
}

/// An own category's name, parent, symbol and color; archive and delete. A system category
/// shows its name and offers the archive only.
struct CategoryEditor: View {
    let target: CategoryEditorTarget

    @Environment(Catalog.self) private var catalog
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context

    @Query(filter: #Predicate<CategoryRecord> { $0.deletedAt == nil }, sort: \CategoryRecord.sortOrder)
    private var categories: [CategoryRecord]

    @State private var draft = CategoryDraft()
    @State private var record: CategoryRecord?
    @State private var isLoaded = false
    @State private var canDelete = false
    @State private var hasChildren = false
    @State private var errorMessage: String?
    @State private var confirmsDelete = false

    var body: some View {
        NavigationStack {
            Form {
                if let record, record.isSystem {
                    Section {
                        HStack(spacing: LunexTheme.Spacing.space3) {
                            SymbolWell(symbol: record.outlineIcon, color: record.color, size: 48)
                            Text(record.displayName(language: localizer.language.rawValue))
                                .lunexText(.titleM)
                        }
                    } footer: {
                        Text(localizer("categories.system.footer"))
                    }
                } else {
                    fields
                }
                if let record {
                    Section {
                        Button(localizer(record.isArchived ? "categories.unarchive" : "categories.archiveAction")) {
                            toggleArchive(record)
                        }
                        if canDelete {
                            Button(localizer("categories.delete"), role: .destructive) { confirmsDelete = true }
                        }
                    } footer: {
                        if !record.isSystem && !canDelete {
                            Text(localizer(hasChildren ? "catalog.error.hasChildren" : "categories.delete.unavailable"))
                        }
                    }
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(LunexColor.negative)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(LunexColor.paper)
            .navigationTitle(title)
            .inlineTitle()
            .toolbar {
                if record?.isSystem == true {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(localizer("add.done")) { dismiss() }
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(localizer("common.cancel")) { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(localizer("common.save"), action: save)
                            .disabled(!draft.isValid)
                    }
                }
            }
            .confirmationDialog(localizer("categories.delete.confirm"), isPresented: $confirmsDelete, titleVisibility: .visible) {
                Button(localizer("categories.delete"), role: .destructive, action: delete)
            }
            .onAppear(perform: load)
        }
        .tint(LunexColor.ink)
    }

    @ViewBuilder
    private var fields: some View {
        Section(localizer("categories.name")) {
            TextField(localizer("categories.name.placeholder"), text: $draft.name)
                .autocorrectionDisabled()
                .onChange(of: draft.name) { _, name in
                    if name.count > 64 { draft.name = String(name.prefix(64)) }
                }
        }
        Section {
            Picker(localizer("categories.parent"), selection: $draft.parentId) {
                Text(localizer("categories.parent.none")).tag(UUID?.none)
                ForEach(parents) { parent in
                    Text(parent.displayName(language: localizer.language.rawValue)).tag(Optional(parent.id))
                }
            }
            .disabled(hasChildren)
        } footer: {
            Text(localizer(hasChildren ? "categories.parent.hasChildren" : "categories.parent.footer"))
        }
        Section(localizer("categories.icon")) {
            SymbolGrid(symbols: Symbols.categories, selection: $draft.icon, color: draft.color, label: localizer("categories.icon"))
        }
        Section(localizer("categories.color")) {
            ColorRow(selection: $draft.color, label: localizer("categories.color"))
        }
    }

    private var title: String {
        switch target {
        case .new: localizer("categories.new")
        case .edit: localizer("categories.edit")
        }
    }

    /// Top-level categories of the same type it can sit under.
    private var parents: [CategoryRecord] {
        categories.filter {
            $0.type == draft.kind.rawValue && $0.parentId == nil && !$0.isArchived && $0.id != record?.id
        }
    }

    private func load() {
        guard !isLoaded else { return }
        isLoaded = true
        switch target {
        case let .new(kind):
            draft.kind = kind
        case let .edit(id):
            guard let found = try? context.fetch(FetchDescriptor<CategoryRecord>(predicate: #Predicate { $0.id == id })).first else { return }
            record = found
            draft = catalog.draft(for: found)
            canDelete = (try? catalog.canDelete(category: id)) ?? false
            hasChildren = categories.contains { $0.parentId == id }
        }
    }

    private func save() {
        do {
            switch target {
            case .new: try catalog.createCategory(draft)
            case let .edit(id): try catalog.updateCategory(id, with: draft)
            }
            dismiss()
        } catch {
            errorMessage = localizer.catalogMessage(error)
        }
    }

    private func toggleArchive(_ record: CategoryRecord) {
        let catalog = catalog
        let id = record.id
        let archiving = !record.isArchived
        do {
            try catalog.setArchived(category: id, archiving)
            if archiving {
                toasts.show(localizer("categories.archivedToast"), actionTitle: localizer("common.undo")) {
                    try? catalog.setArchived(category: id, false)
                }
            }
            dismiss()
        } catch {
            errorMessage = localizer.catalogMessage(error)
        }
    }

    private func delete() {
        guard let record else { return }
        do {
            try catalog.deleteCategory(record.id)
            dismiss()
        } catch {
            errorMessage = localizer.catalogMessage(error)
        }
    }
}
